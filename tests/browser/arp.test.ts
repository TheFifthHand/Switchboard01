/**
 * Arpeggiator, recording options, the Tips switch and the keyboard legends,
 * in real Chromium: every control changes the project (or the remembered UI
 * setting), drum parts get an explanation instead of arp controls, and white
 * keys carry at most one legend so nothing overlaps the scale dots.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ArpStrip } from '../../src/app/views/ArpPanel';
import { KeyboardStrip } from '../../src/app/views/KeyboardStrip';
import { RecordOptions } from '../../src/app/views/RecordOptions';
import { TransportBar } from '../../src/app/views/TransportBar';
import { getStarter } from '../../src/content/starters';
import type { Id } from '../../src/project/types';
import { selectTrack, setKeyboardOctave, setPadMode, setTipsEnabled, uiStore } from '../../src/state/uiStore';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, fire, key, mount } from './ui-harness';

beforeEach(() => {
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off' });
    setPadMode('loops');
    selectTrack('t4');
    setKeyboardOctave(4);
  });
});

afterEach(() => {
  cleanup();
  act(() => setTipsEnabled(true));
});

const arp = (id: Id) => session.store.getState().tracks.find((t) => t.id === id)!.arp;
const settings = () => session.store.getState().settings;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function click(el: Element) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}
function byRole(root: ParentNode, role: string, name: string | RegExp): HTMLElement {
  const els = [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
  const found = els.find((e) => {
    const label = e.getAttribute('aria-label') ?? (e.getAttribute('aria-labelledby') ? document.getElementById(e.getAttribute('aria-labelledby')!)?.textContent : null) ?? e.textContent ?? '';
    return typeof name === 'string' ? label.trim() === name || e.textContent?.trim() === name : name.test(label);
  });
  if (!found) throw new Error(`no ${role} "${String(name)}"`);
  return found;
}

describe('Arpeggiator', () => {
  it('the strip switch turns the arp on for the selected melodic part (undoable)', () => {
    const m = mount(h(ArpStrip, { trackId: 't4' }));
    expect(arp('t4').enabled).toBe(false);
    const sw = byRole(m.container, 'switch', 'Arp');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    click(sw);
    expect(arp('t4').enabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    act(() => session.undo());
    expect(arp('t4').enabled).toBe(false);
  });

  it('the settings panel changes rate, pattern, range, latch and gate in the project', () => {
    const m = mount(h(ArpStrip, { trackId: 't4' }));
    const summary = m.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    expect(summary.textContent).toContain('1/16 · Up · 1 oct');
    click(summary);
    const d = dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Arpeggiator settings for Chords');
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    click(byRole(d, 'radio', '1/8T'));
    expect(arp('t4').division).toBe('1/8T');
    click(byRole(d, 'radio', 'Up-Down'));
    expect(arp('t4').mode).toBe('updown');
    click(byRole(d, 'radio', '3 oct'));
    expect(arp('t4').octaves).toBe(3);
    click(byRole(d, 'switch', 'Latch'));
    expect(arp('t4').latch).toBe(true);
    click(byRole(d, 'switch', 'Arpeggiator'));
    expect(arp('t4').enabled).toBe(true);

    // Gate knob: arrow keys move it; the change is stored once when the gesture ends.
    const gate = byRole(d, 'slider', /Gate/);
    const before = arp('t4').gate;
    act(() => gate.focus());
    key(gate, 'keydown', { key: 'ArrowUp' });
    key(gate, 'keydown', { key: 'ArrowUp' });
    act(() => gate.blur());
    expect(arp('t4').gate).toBeGreaterThan(before);
    expect(summary.textContent).toContain('1/8T · Up-Down · 3 oct · Latch');
    // Tip explains timing and Musical Assist.
    expect(d.textContent).toMatch(/in time with the beat/);
    expect(d.textContent).toMatch(/Musical Assist keeps every note in/);
    // Escape closes and returns focus to the summary key.
    const latch = byRole(d, 'switch', 'Latch');
    act(() => latch.focus());
    key(latch, 'keydown', { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(summary);
  });

  it('drum parts get an explanation instead of arp controls', () => {
    const m = mount(h(ArpStrip, { trackId: 't1' }));
    expect(m.container.querySelector('[role="switch"]')).toBeNull();
    expect(m.container.textContent).toMatch(/For melodic parts/);
  });

  it('arp changes are refused while a performance is recording', () => {
    session.store.setLock('Recording a performance', () => false);
    try {
      const m = mount(h(ArpStrip, { trackId: 't4' }));
      click(byRole(m.container, 'switch', 'Arp'));
      expect(arp('t4').enabled).toBe(false);
    } finally {
      session.store.setLock(null);
    }
  });
});

describe('Recording options', () => {
  it('metronome, count-in and Record Notes quantize change the project settings', () => {
    const m = mount(h(RecordOptions));
    expect(settings()).toMatchObject({ metronome: false, countIn: false, recordQuantize: '1/16' });
    const trigger = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Recording options"]')!;
    expect(trigger.getAttribute('aria-label')).toContain('metronome off');
    click(trigger);
    const d = dialog()!;
    click(byRole(d, 'switch', 'Metronome'));
    expect(settings().metronome).toBe(true);
    click(byRole(d, 'switch', 'One-bar count-in'));
    expect(settings().countIn).toBe(true);
    click(byRole(d, 'radio', '1/8'));
    expect(settings().recordQuantize).toBe('1/8');
    expect(d.textContent).toMatch(/nearest half-beat/);
    click(byRole(d, 'radio', 'Off'));
    expect(settings().recordQuantize).toBe('off');
    expect(d.textContent).toMatch(/exactly where you played them/);
    expect(trigger.getAttribute('aria-label')).toContain('metronome on, count-in on');
    act(() => session.undo());
    expect(settings().recordQuantize).toBe('1/8');
    // Pressing the trigger again closes the panel.
    click(trigger);
    expect(dialog()).toBeNull();
  });
});

describe('Transport strip', () => {
  it('the Tips switch toggles the remembered Tips setting', () => {
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const sw = byRole(m.container, 'switch', 'Tips');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    click(sw);
    expect(uiStore.getState().tipsEnabled).toBe(false);
    click(sw);
    expect(uiStore.getState().tipsEnabled).toBe(true);
  });

  it('shows the recording state in text next to the two record buttons', () => {
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const group = m.container.querySelector('[role="group"][aria-label="Recording"]')!;
    expect(group.querySelector('button[aria-label="Record Notes"]')).not.toBeNull();
    expect(group.querySelector('button[aria-label="Record Performance"]')).not.toBeNull();
    expect(group.textContent).toMatch(/^Record/);
    act(() => patchRuntime({ recording: 'notes', recordTarget: { trackId: 't3', slot: 0 } }));
    expect(group.textContent).toContain('Recording notes · Bass');
    // The button now says what pressing it does.
    expect(group.querySelector('button[aria-label="Stop recording notes"]')).not.toBeNull();
    act(() => patchRuntime({ recording: 'performance', recordTarget: null }));
    expect(group.textContent).toContain('Recording performance');
    expect(group.querySelector('button[aria-label="Stop recording performance"]')).not.toBeNull();
    act(() => patchRuntime({ recording: 'off', recordTarget: null }));
  });
});

describe('Keyboard legends', () => {
  it('each white key shows one legend at most: the computer key, or the note name on C (and the root) keys', () => {
    const m = mount(h('div', { style: { width: '1340px', height: '100px' } }, h(KeyboardStrip)), { width: 1366 });
    const whites = [...m.container.querySelectorAll<HTMLElement>('[data-midi]')].filter((k) => !/#/.test(k.dataset.note ?? ''));
    expect(whites.length).toBe(15);
    const root = session.store.getState().root;
    for (const k of whites) {
      const legend = k.lastElementChild!;
      expect(legend.children.length).toBeLessThanOrEqual(1);
      const pc = Number(k.dataset.midi) % 12;
      if (pc === 0) expect(legend.textContent).toBe(k.dataset.note);
    }
    // Computer keys still label the other white keys (S = D4 in the default layout).
    const d4 = whites.find((k) => k.dataset.note === 'D4')!;
    if (root !== 2) expect(d4.lastElementChild!.textContent).toBe('S');
    // The legend sits below the scale dot (allowing for the 2 px of leading above the glyphs in its line box).
    for (const k of whites) {
      const dot = [...k.children].find((c) => c.tagName === 'SPAN' && c !== k.firstElementChild && c !== k.lastElementChild) as HTMLElement | undefined;
      const legend = k.lastElementChild!.firstElementChild as HTMLElement | null;
      if (!dot || !legend) continue;
      expect(legend.getBoundingClientRect().top).toBeGreaterThanOrEqual(dot.getBoundingClientRect().bottom - 2);
    }
  });
});
