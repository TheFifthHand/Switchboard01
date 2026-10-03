import { createElement as h, Fragment } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, MiniKeyboard } from '../../src/ui/components';
import { drumKeyHint, noteKeyLabels, useComputerKeyboard, type ComputerKeyboardLayout } from '../../src/ui/hooks/useComputerKeyboard';
import { cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';
import { centre, click } from './r4-uikit-input';

afterEach(cleanup);

type Ev = ['on', number, number] | ['off', number];

/* ------------------------------------------------------------------ */
/* MiniKeyboard                                                        */
/* ------------------------------------------------------------------ */

function setupKeys(props: Record<string, unknown> = {}) {
  const events: Ev[] = [];
  const el = () =>
    h(MiniKeyboard, {
      baseNote: 48,
      onNoteOn: (m: number, v: number) => events.push(['on', m, v]),
      onNoteOff: (m: number) => events.push(['off', m]),
      ...props,
    });
  const m = mount(el(), { width: 780 });
  const board = m.container.querySelector<HTMLElement>('[role="group"]')!;
  const keyEl = (midi: number) => board.querySelector<HTMLElement>(`[data-midi="${midi}"]`)!;
  /** A point on a white key below the black keys (fraction 0.62..1 of the height). */
  const whitePoint = (midi: number, y = 0.85) => {
    const r = keyEl(midi).getBoundingClientRect();
    const b = board.getBoundingClientRect();
    return { clientX: r.left + r.width * 0.5, clientY: b.top + b.height * y };
  };
  return { events, m, board, keyEl, whitePoint, el };
}

describe('MiniKeyboard', () => {
  it('has 25 keys from C3 to C5 and an accessible name', () => {
    const { board } = setupKeys();
    const keys = board.querySelectorAll('[data-midi]');
    expect(keys).toHaveLength(25);
    expect(keys[0].getAttribute('data-note')).toBe('C3');
    expect(keys[24].getAttribute('data-note')).toBe('C5');
    expect(board.getAttribute('aria-label')).toBe('Keyboard, C3 to C5');
  });

  it('pointer down starts a note and pointer up ends it', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(48));
    pointer(board, 'pointerup', whitePoint(48));
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 48],
      ['off', 48],
    ]);
  });

  it('black keys are hit on their upper part', () => {
    const { events, board, keyEl } = setupKeys();
    const p = pointIn(keyEl(49), 0.5);
    pointer(board, 'pointerdown', p);
    pointer(board, 'pointerup', p);
    expect(events[0].slice(0, 2)).toEqual(['on', 49]);
  });

  it('lower on a key plays louder', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(52, 0.66));
    pointer(board, 'pointerup', whitePoint(52, 0.66));
    pointer(board, 'pointerdown', whitePoint(52, 0.97));
    pointer(board, 'pointerup', whitePoint(52, 0.97));
    const ons = events.filter((e): e is ['on', number, number] => e[0] === 'on');
    expect(ons).toHaveLength(2);
    expect(ons[1][2]).toBeGreaterThan(ons[0][2]);
    for (const [, , v] of ons) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('gliding across keys releases the previous note and starts the next', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(48));
    pointer(board, 'pointermove', whitePoint(48)); // same key: nothing new
    pointer(board, 'pointermove', whitePoint(50));
    pointer(board, 'pointermove', whitePoint(52));
    pointer(board, 'pointerup', whitePoint(52));
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 48],
      ['off', 48],
      ['on', 50],
      ['off', 50],
      ['on', 52],
      ['off', 52],
    ]);
  });

  it('gliding off the keyboard releases the note', () => {
    const { events, board, whitePoint } = setupKeys();
    const b = board.getBoundingClientRect();
    pointer(board, 'pointerdown', whitePoint(48));
    pointer(board, 'pointermove', { clientX: b.left + 10, clientY: b.bottom + 40 });
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 48],
      ['off', 48],
    ]);
    pointer(board, 'pointerup', { clientX: b.left + 10, clientY: b.bottom + 40 });
    expect(events).toHaveLength(2);
  });

  it('pointercancel and lost capture release the note', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(55));
    pointer(board, 'pointercancel', whitePoint(55));
    pointer(board, 'pointerdown', { ...whitePoint(57), pointerId: 2 });
    pointer(board, 'lostpointercapture', { ...whitePoint(57), pointerId: 2 });
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 55],
      ['off', 55],
      ['on', 57],
      ['off', 57],
    ]);
  });

  it('pointerleave with no buttons pressed releases the note', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(60));
    // React derives pointerleave from pointerout to an element outside the keyboard.
    pointer(board, 'pointerout', { ...whitePoint(60), buttons: 0, relatedTarget: document.body });
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 60],
      ['off', 60],
    ]);
  });

  it('window blur releases every held note', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', { ...whitePoint(48), pointerId: 1 });
    pointer(board, 'pointerdown', { ...whitePoint(52), pointerId: 2, pointerType: 'touch' });
    fire(window, new Event('blur'));
    expect(events.filter((e) => e[0] === 'off').map((e) => e[1]).sort()).toEqual([48, 52]);
    // The pointers are forgotten: a late pointerup does not send a second note-off.
    pointer(board, 'pointerup', whitePoint(48));
    expect(events.filter((e) => e[0] === 'off')).toHaveLength(2);
  });

  it('multi-touch: each pointer plays its own note; a shared key sounds once', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', { ...whitePoint(48), pointerId: 11, pointerType: 'touch' });
    pointer(board, 'pointerdown', { ...whitePoint(55), pointerId: 12, pointerType: 'touch' });
    pointer(board, 'pointermove', { ...whitePoint(48), pointerId: 12, pointerType: 'touch' }); // second finger slides onto the first key
    pointer(board, 'pointerup', { ...whitePoint(48), pointerId: 11, pointerType: 'touch' });
    expect(events.filter((e) => e[0] === 'off').map((e) => e[1])).toEqual([55]); // 48 is still held by finger 12
    pointer(board, 'pointerup', { ...whitePoint(48), pointerId: 12, pointerType: 'touch' });
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 48],
      ['on', 55],
      ['off', 55],
      ['off', 48],
    ]);
  });

  it('unmounting and disabling release held notes', () => {
    const a = setupKeys();
    pointer(a.board, 'pointerdown', a.whitePoint(48));
    a.m.unmount();
    expect(a.events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 48],
      ['off', 48],
    ]);

    const b = setupKeys();
    pointer(b.board, 'pointerdown', b.whitePoint(50));
    b.m.rerender(h(MiniKeyboard, { baseNote: 48, disabled: true, onNoteOn: () => {}, onNoteOff: (m: number) => b.events.push(['off', m]) }));
    expect(b.events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 50],
      ['off', 50],
    ]);
  });

  it('an octave change under a held key releases it (the key now means another note)', () => {
    const events: Ev[] = [];
    const props = (baseNote: number) => ({
      baseNote,
      onNoteOn: (m: number, v: number) => events.push(['on', m, v]),
      onNoteOff: (m: number) => events.push(['off', m]),
    });
    const m = mount(h(MiniKeyboard, props(48)), { width: 780 });
    const board = m.container.querySelector<HTMLElement>('[role="group"]')!;
    const p = pointIn(board.querySelector('[data-midi="50"]')!, 0.85);
    pointer(board, 'pointerdown', p);
    m.rerender(h(MiniKeyboard, props(60)));
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 50],
      ['off', 50],
    ]);
    expect(board.querySelector('[data-midi="50"]')).toBeNull();
    // The late pointerup does not send a stray note-off for the new layout.
    pointer(board, 'pointerup', p);
    expect(events).toHaveLength(2);
  });

  it('the tab becoming hidden releases held notes', () => {
    const { events, board, whitePoint } = setupKeys();
    pointer(board, 'pointerdown', whitePoint(53));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      fire(document, new Event('visibilitychange'));
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['on', 53],
      ['off', 53],
    ]);
  });

  it('shows active notes, key labels and the scale', () => {
    const { board, keyEl } = setupKeys({
      activeNotes: new Set([52]),
      keyLabels: noteKeyLabels(48),
      scaleMask: [true, false, true, true, false, true, false, true, true, false, true, false], // C minor
      rootPc: 0,
    });
    expect(keyEl(52).hasAttribute('data-lit')).toBe(true);
    expect(keyEl(50).hasAttribute('data-lit')).toBe(false);
    expect(keyEl(48).textContent).toContain('A');
    expect(keyEl(49).textContent).toContain('W');
    expect(keyEl(51).getAttribute('data-scale')).toBe('in'); // Eb
    expect(keyEl(52).getAttribute('data-scale')).toBe('out'); // E natural
    expect(keyEl(60).hasAttribute('data-root')).toBe(true);
    expect(board.querySelectorAll('[data-scale="in"]').length).toBeGreaterThan(10);
  });
});

/* ------------------------------------------------------------------ */
/* useComputerKeyboard                                                 */
/* ------------------------------------------------------------------ */

type KbEv = ['on', number, number] | ['off', number] | ['oct', number];

function Harness(props: { enabled: boolean; layout: ComputerKeyboardLayout; log: KbEv[] }) {
  useComputerKeyboard({
    enabled: props.enabled,
    layout: props.layout,
    onNoteOn: (i, v) => props.log.push(['on', i, v]),
    onNoteOff: (i) => props.log.push(['off', i]),
    onOctave: (d) => props.log.push(['oct', d]),
  });
  return h(Fragment, null, h('input', { 'data-testid': 'text', defaultValue: '' }), h('div', { contentEditable: true, 'data-testid': 'editable' }), h('button', { 'data-testid': 'button' }, 'A button'));
}

function setupHook(layout: ComputerKeyboardLayout = 'notes', enabled = true) {
  const log: KbEv[] = [];
  const m = mount(h(Harness, { enabled, layout, log }));
  const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { log, m, q };
}

describe('useComputerKeyboard', () => {
  it('plays notes from the home row: A = 0, W = 1, K = 12, apostrophe = 17', () => {
    const { log } = setupHook();
    for (const code of ['KeyA', 'KeyW', 'KeyK', 'Quote']) {
      key(document.body, 'keydown', { code, key: 'x' });
      key(document.body, 'keyup', { code, key: 'x' });
    }
    expect(log).toEqual([
      ['on', 0, 0.8],
      ['off', 0],
      ['on', 1, 0.8],
      ['off', 1],
      ['on', 12, 0.8],
      ['off', 12],
      ['on', 17, 0.8],
      ['off', 17],
    ]);
  });

  it('ignores typing in text fields and editable content', () => {
    const { log, q } = setupHook();
    key(q('text'), 'keydown', { code: 'KeyA', key: 'a' });
    key(q('text'), 'keyup', { code: 'KeyA', key: 'a' });
    key(q('editable'), 'keydown', { code: 'KeyS', key: 's' });
    expect(log).toEqual([]);
    // A focused button is not a text field: notes play.
    key(q('button'), 'keydown', { code: 'KeyD', key: 'd' });
    expect(log).toEqual([['on', 4, 0.8]]);
  });

  it('ignores Ctrl/Meta/Alt chords, key repeats and events already handled by a control', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyS', key: 's', ctrlKey: true });
    key(document.body, 'keydown', { code: 'KeyS', key: 's', metaKey: true });
    key(document.body, 'keydown', { code: 'KeyS', key: 's', altKey: true });
    const handled = new KeyboardEvent('keydown', { code: 'KeyS', key: 's', bubbles: true, cancelable: true });
    handled.preventDefault();
    fire(document.body, handled);
    expect(log).toEqual([]);
    key(document.body, 'keydown', { code: 'KeyS', key: 's' });
    key(document.body, 'keydown', { code: 'KeyS', key: 's', repeat: true });
    key(document.body, 'keydown', { code: 'KeyS', key: 's', repeat: true });
    expect(log).toEqual([['on', 2, 0.8]]);
  });

  it('releases a held key on key-up even when a modifier is now held', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyF', key: 'f' });
    key(document.body, 'keyup', { code: 'KeyF', key: 'f', ctrlKey: true });
    expect(log).toEqual([
      ['on', 5, 0.8],
      ['off', 5],
    ]);
  });

  it('Shift plays an accent', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyG', key: 'G', shiftKey: true });
    expect(log).toEqual([['on', 7, 1]]);
  });

  it('releases held keys on window blur and when the tab is hidden', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyA', key: 'a' });
    key(document.body, 'keydown', { code: 'KeyJ', key: 'j' });
    fire(window, new Event('blur'));
    expect(log.filter((e) => e[0] === 'off').map((e) => e[1]).sort((a, b) => a - b)).toEqual([0, 11]);
    // The later key-ups are ignored (already released).
    key(document.body, 'keyup', { code: 'KeyA', key: 'a' });
    expect(log.filter((e) => e[0] === 'off')).toHaveLength(2);

    key(document.body, 'keydown', { code: 'KeyH', key: 'h' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      fire(document, new Event('visibilitychange'));
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    expect(log.at(-1)).toEqual(['off', 9]);
  });

  it('Z / X release held notes, then shift the octave', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyA', key: 'a' });
    key(document.body, 'keydown', { code: 'KeyX', key: 'x' });
    key(document.body, 'keydown', { code: 'KeyZ', key: 'z' });
    key(document.body, 'keyup', { code: 'KeyA', key: 'a' });
    expect(log).toEqual([
      ['on', 0, 0.8],
      ['off', 0],
      ['oct', 1],
      ['oct', -1],
    ]);
  });

  it('plays nothing while a modal dialog is open, but still releases a note held before it opened', () => {
    const { log } = setupHook();
    key(document.body, 'keydown', { code: 'KeyA', key: 'a' });
    const d = mount(h(Dialog, { open: true, onClose: () => {}, title: 'Export audio' }, h('button', { type: 'button' }, 'Export')));
    const inDialog = document.activeElement!;
    expect(inDialog.closest('[role="dialog"]')).not.toBeNull();
    key(inDialog, 'keydown', { code: 'KeyS', key: 's' }); // a note key on a dialog button
    key(inDialog, 'keydown', { code: 'KeyX', key: 'x' }); // an octave key
    key(inDialog, 'keyup', { code: 'KeyA', key: 'a' });
    expect(log).toEqual([
      ['on', 0, 0.8],
      ['off', 0],
    ]);
    d.unmount();
    key(document.body, 'keydown', { code: 'KeyS', key: 's' });
    expect(log.at(-1)).toEqual(['on', 2, 0.8]);
  });

  it('drums layout: rows of keys match rows of pads (Z = pad 0 bottom-left, 1 = pad 12 top-left)', () => {
    const { log } = setupHook('drums');
    for (const code of ['KeyZ', 'KeyV', 'KeyA', 'KeyQ', 'Digit1', 'Digit4']) key(document.body, 'keydown', { code, key: 'x' });
    expect(log.map((e) => e[1])).toEqual([0, 3, 4, 8, 12, 15]);
    expect(drumKeyHint(0)).toBe('Z');
    expect(drumKeyHint(15)).toBe('4');
    expect(noteKeyLabels(60)[61]).toBe('W');
  });

  it('disabling or unmounting releases held keys and stops listening', () => {
    const log: KbEv[] = [];
    const m = mount(h(Harness, { enabled: true, layout: 'notes', log }));
    key(document.body, 'keydown', { code: 'KeyE', key: 'e' });
    m.rerender(h(Harness, { enabled: false, layout: 'notes', log }));
    expect(log).toEqual([
      ['on', 3, 0.8],
      ['off', 3],
    ]);
    key(document.body, 'keydown', { code: 'KeyE', key: 'e' });
    expect(log).toHaveLength(2);

    m.rerender(h(Harness, { enabled: true, layout: 'notes', log }));
    key(document.body, 'keydown', { code: 'KeyL', key: 'l' });
    m.unmount();
    expect(log.slice(2)).toEqual([
      ['on', 14, 0.8],
      ['off', 14],
    ]);
    key(document.body, 'keydown', { code: 'KeyL', key: 'l' });
    expect(log).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* MiniKeyboard: kit row and key-spelled names (real mouse)            */
/* ------------------------------------------------------------------ */

describe('MiniKeyboard kit row and spelling', () => {
  it("kit 'row': 16 named keys in one row of four groups (Z–V, A–F, Q–R, 1–4); the mouse plays the key under it, a gap plays its nearest key", async () => {
    const events: Ev[] = [];
    const names = Array.from({ length: 16 }, (_, i) => `Sound ${i + 1}`);
    const letters = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [60 + i, drumKeyHint(i)!]));
    const m = mount(
      h('div', { style: { width: '900px' } }, h(MiniKeyboard, { variant: 'kit', kitLayout: 'row', baseNote: 60, height: 90, kitNames: names, keyLabels: letters, onNoteOn: (n: number, v: number) => events.push(['on', n, v]), onNoteOff: (n: number) => events.push(['off', n]) })),
      { width: 940 },
    );
    const board = m.container.querySelector<HTMLElement>('[role="group"]')!;
    const keys = [...board.querySelectorAll<HTMLElement>('[data-midi]')];
    expect(keys).toHaveLength(16);
    expect(new Set(keys.map((k) => Math.round(k.getBoundingClientRect().top))).size).toBe(1);
    expect(keys.map((k) => k.textContent)).toEqual(names.map((n, i) => `${n}${drumKeyHint(i)}`));
    for (const k of keys) expect(k.getBoundingClientRect().height).toBeGreaterThanOrEqual(80);
    // Groups of four: the space between groups is wider than between keys in a group.
    const gap = (a: number, b: number) => keys[b].getBoundingClientRect().left - keys[a].getBoundingClientRect().right;
    expect(gap(3, 4)).toBeGreaterThan(gap(2, 3) + 2);
    await click(centre(keys[5], 0.5, 0.9));
    const between = { x: (keys[3].getBoundingClientRect().right + keys[4].getBoundingClientRect().left) / 2 + 2, y: centre(keys[4]).y };
    await click(between);
    expect(events.filter((e) => e[0] === 'on').map((e) => e[1])).toEqual([65, 64]);
    expect(events.filter((e) => e[0] === 'off').map((e) => e[1])).toEqual([65, 64]);
  });

  it('pitchNames spell the root on the rail and in legends the way the key writes it (B♭, not A#)', () => {
    const flats = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
    const rail = mount(h('div', { style: { width: '760px' } }, h(MiniKeyboard, { baseNote: 60, height: 90, rootPc: 10, pitchNames: flats, noteNames: 'above', onNoteOn: () => {}, onNoteOff: () => {} })), { width: 800 });
    expect([...rail.container.querySelectorAll('[class*="railName"]')].map((r) => r.textContent)).toEqual(['C4', 'B♭', 'C5', 'B♭', 'C6']);
    const legend = mount(h('div', { style: { width: '760px' } }, h(MiniKeyboard, { baseNote: 60, height: 90, rootPc: 10, pitchNames: flats, onNoteOn: () => {}, onNoteOff: () => {} })), { width: 800 });
    // B♭ is a black key: its name shows on the rail only; the white C keys keep C4 / C5.
    expect(legend.container.querySelector('[data-midi="60"] [class*="name"]')!.textContent).toBe('C4');
  });
});
