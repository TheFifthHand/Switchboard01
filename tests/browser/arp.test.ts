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
import { setArp, setSettings } from '../../src/state/commands';
import { selectTrack, setKeyboardOctave, setPadMode, setTipsEnabled, setUiMode, uiStore } from '../../src/state/uiStore';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';
import '../../src/ui/theme.css';

/** Text is measured in the app's own fonts (they load on first use). */
async function appFonts(): Promise<void> {
  await Promise.all(['600 10px "Inter Variable"', '400 11px "Inter Variable"'].map((f) => document.fonts.load(f)));
}

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
  act(() => {
    setTipsEnabled(true);
    setUiMode('simple');
  });
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

  it('the computer keyboard keeps playing while focus is in the settings panel', () => {
    const played: string[] = [];
    const realOn = session.noteOn;
    const realOff = session.noteOff;
    session.noteOn = (trackId, pitch) => void played.push(`on ${trackId} ${pitch}`);
    session.noteOff = (trackId, pitch) => void played.push(`off ${trackId} ${pitch}`);
    try {
      // The arpeggiator strip is part of Advanced.
      act(() => setUiMode('advanced'));
      const m = mount(h('div', { style: { width: '1340px', height: '100px' } }, h(KeyboardStrip)), { width: 1366 });
      click(m.container.querySelector<HTMLButtonElement>('button[aria-label^="Arpeggiator settings"]')!);
      const rate = byRole(dialog()!, 'radio', '1/8');
      act(() => rate.focus());
      key(rate, 'keydown', { key: 'a', code: 'KeyA' });
      key(rate, 'keyup', { key: 'a', code: 'KeyA' });
      // A = the lowest key (C4 at the default octave).
      expect(played).toEqual(['on t4 60', 'off t4 60']);
      // The panel stays open while playing.
      expect(dialog()).not.toBeNull();
    } finally {
      session.noteOn = realOn;
      session.noteOff = realOff;
    }
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
  it('the Simple · Advanced switch and Tips (in More) change remembered UI settings, never the project', () => {
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const before = session.store.getState();
    const group = byRole(m.container, 'radiogroup', 'Simple or Advanced');
    expect(byRole(group, 'radio', 'Simple').getAttribute('aria-checked')).toBe('true');
    // Swing is an Advanced control.
    expect(m.container.textContent).not.toContain('Swing');
    click(byRole(group, 'radio', 'Advanced'));
    expect(uiStore.getState().uiMode).toBe('advanced');
    expect(m.container.textContent).toContain('Swing');
    click(byRole(group, 'radio', 'Simple'));
    expect(uiStore.getState().uiMode).toBe('simple');
    expect(session.store.getState()).toBe(before);

    const more = m.container.querySelector<HTMLButtonElement>('button[aria-label^="More:"]')!;
    click(more);
    const tips = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((b) => b.textContent?.includes('Tips'))!;
    expect(tips.getAttribute('aria-checked')).toBe('true');
    click(tips);
    expect(uiStore.getState().tipsEnabled).toBe(false);
    click(more);
    click([...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((b) => b.textContent?.includes('Tips'))!);
    expect(uiStore.getState().tipsEnabled).toBe(true);
  });

  it('the More menu (narrow screens) reaches Undo, Tips, Projects and Export', () => {
    const opened: string[] = [];
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => opened.push('library'), onOpenExport: () => opened.push('export') }) }), { width: 1024 });
    const more = m.container.querySelector<HTMLButtonElement>('button[aria-label^="More:"]')!;
    click(more);
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="More"]')!;
    const item = (text: string) => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((b) => b.textContent?.includes(text))!;
    // Nothing to undo yet: offered, but disabled with the reason.
    expect(item('Undo').getAttribute('aria-disabled')).toBe('true');
    expect(item('Undo').textContent).toContain('Nothing to undo');
    const tips = item('Tips');
    expect(tips.getAttribute('aria-checked')).toBe('true');
    click(tips);
    expect(uiStore.getState().tipsEnabled).toBe(false);
    expect(document.querySelector('[role="menu"][aria-label="More"]')).toBeNull();
    click(more);
    click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.textContent?.includes('Export WAV'))!);
    click(more);
    click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.textContent?.includes('Projects'))!);
    expect(opened).toEqual(['export', 'library']);
    // An edit makes Undo available from the menu.
    act(() => void session.setBpm(131));
    click(more);
    const undo = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.textContent?.includes('Undo'))!;
    expect(undo.getAttribute('aria-disabled')).toBeNull();
    click(undo);
    expect(session.store.getState().bpm).toBe(124);
  });

  it('shows the recording state in text next to the two record buttons', () => {
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const group = m.container.querySelector('[role="group"][aria-label="Recording"]')!;
    expect(group.querySelector('button[aria-label="Record Notes"]')).not.toBeNull();
    expect(group.querySelector('button[aria-label="Record Performance"]')).not.toBeNull();
    expect(group.textContent).toMatch(/^Record/);
    act(() => patchRuntime({ recording: 'notes', recordTarget: { trackId: 't3', slot: 0 } }));
    expect(group.textContent).toContain('Recording · Bass');
    // The button now says what pressing it does.
    expect(group.querySelector('button[aria-label="Stop recording notes"]')).not.toBeNull();
    act(() => patchRuntime({ recording: 'performance', recordTarget: null }));
    expect(group.textContent).toContain('Recording performance');
    expect(group.querySelector('button[aria-label="Stop recording performance"]')).not.toBeNull();
    act(() => patchRuntime({ recording: 'off', recordTarget: null }));
  });

  it('shows the Record Notes grid while notes record (and once it is not the usual 1/16), never cut off', async () => {
    await appFonts();
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const group = m.container.querySelector('[role="group"][aria-label="Recording"]')!;
    expect(group.textContent).not.toMatch(/snap/i);
    act(() => patchRuntime({ recording: 'notes', recordTarget: { trackId: 't4', slot: 1 } }));
    expect(group.textContent).toContain('Recording · Chords · Snap 1/16');
    const snap = [...group.querySelectorAll('span')].find((s) => s.textContent === ' · Snap 1/16')!;
    const text = snap.previousElementSibling as HTMLElement;
    // Both fit above the buttons for a usual part name; a longer name gives way first, never the grid.
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    const caption = () => snap.parentElement!.getBoundingClientRect();
    expect(snap.getBoundingClientRect().right).toBeLessThanOrEqual(caption().right + 1);
    act(() => patchRuntime({ recordTarget: { trackId: 't2', slot: 1 } }));
    expect(group.textContent).toContain('Recording · Percussion · Snap 1/16');
    expect(snap.getBoundingClientRect().right).toBeLessThanOrEqual(caption().right + 1);
    expect(snap.scrollWidth).toBeLessThanOrEqual(snap.clientWidth + 1);
    // With the part's arpeggiator on, its notes are recorded on its own rate: that grid is shown instead.
    act(() => void session.accepted(setArp(session.store, 't4', { enabled: true, division: '1/8T' })));
    act(() => patchRuntime({ recordTarget: { trackId: 't4', slot: 1 } }));
    expect(group.textContent).toContain('Recording · Chords · Arp 1/8T');
    expect(group.textContent).not.toMatch(/snap/i);
    expect(snap.getBoundingClientRect().right).toBeLessThanOrEqual(caption().right + 1);
    act(() => patchRuntime({ recordTarget: { trackId: 't2', slot: 1 } }));
    // The chosen clip is not the one playing yet: recording starts with it at the next bar.
    act(() => patchRuntime({ playing: true, tracks: { t2: { playingSlot: 0, queued: { slot: 1, atTick: 384 } } } }));
    expect(group.textContent).toContain('Next bar · Percussion');
    act(() => patchRuntime({ tracks: { t2: { playingSlot: 1, queued: null } } }));
    expect(group.textContent).toContain('Recording · Percussion');
    act(() => patchRuntime({ playing: false, tracks: {} }));
    act(() => void session.accepted(setSettings(session.store, { recordQuantize: 'off' })));
    expect(group.textContent).toContain('No snap');
    act(() => patchRuntime({ recording: 'off', recordTarget: null }));
    expect(group.textContent).toContain('Record · No snap');
  });
});

describe('Keyboard strip: held keys, drum parts and recordings', () => {
  /** Stand in for the session's notes: the part and pitch each press and release goes to. */
  function recordNotes() {
    const played: string[] = [];
    const realOn = session.noteOn;
    const realOff = session.noteOff;
    session.noteOn = (trackId, pitch) => void played.push(`on ${trackId} ${pitch}`);
    session.noteOff = (trackId, pitch) => void played.push(`off ${trackId} ${pitch}`);
    return {
      played,
      restore() {
        session.noteOn = realOn;
        session.noteOff = realOff;
      },
    };
  }
  const strip = () => mount(h('div', { style: { width: '1340px', height: '100px' } }, h(KeyboardStrip)), { width: 1366 });

  it('a computer key held while the part or the octave changes is released on its own part and pitch', () => {
    const rec = recordNotes();
    try {
      const m = strip();
      key(document.body, 'keydown', { key: 'a', code: 'KeyA' });
      act(() => selectTrack('t3'));
      key(document.body, 'keyup', { key: 'a', code: 'KeyA' });
      expect(rec.played).toEqual(['on t4 60', 'off t4 60']);

      rec.played.length = 0;
      key(document.body, 'keydown', { key: 's', code: 'KeyS' });
      click(m.container.querySelector<HTMLButtonElement>('button[aria-label="Octave up (X)"]')!);
      key(document.body, 'keyup', { key: 's', code: 'KeyS' });
      expect(rec.played).toEqual(['on t3 62', 'off t3 62']);
      // The next press plays in the new octave.
      key(document.body, 'keydown', { key: 's', code: 'KeyS' });
      key(document.body, 'keyup', { key: 's', code: 'KeyS' });
      expect(rec.played.slice(2)).toEqual(['on t3 74', 'off t3 74']);
    } finally {
      rec.restore();
    }
  });

  it('a mouse or touch key held while the part changes is released on its own part', () => {
    const rec = recordNotes();
    try {
      const m = strip();
      const board = m.container.querySelector<HTMLElement>('[role="group"][aria-label^="Keyboard playing"]')!;
      const e4 = pointIn(board.querySelector('[data-midi="64"]')!, 0.85);
      pointer(board, 'pointerdown', { ...e4, pointerId: 7, pointerType: 'touch' });
      act(() => selectTrack('t5'));
      pointer(board, 'pointerup', { ...e4, pointerId: 7, pointerType: 'touch' });
      expect(rec.played).toEqual(['on t4 64', 'off t4 64']);
    } finally {
      rec.restore();
    }
  });

  it('a drum part gets 16 named kit keys, no octave to shift, and the drum-pad key layout (Z–V / A–F / Q–R / 1–4)', () => {
    const rec = recordNotes();
    try {
      act(() => selectTrack('t1'));
      const m = strip();
      const keys = [...m.container.querySelectorAll<HTMLElement>('[role="group"][aria-label^="Keyboard playing"] [data-midi]')];
      expect(keys).toHaveLength(16);
      // Each key names its sound and shows its letter: Kick on Z, the closed hat on A.
      expect(keys[0].textContent).toMatch(/Z$/);
      expect(keys[4].textContent).toMatch(/A$/);
      // A kit has no octave: no octave keys or reset.
      for (const label of ['Octave down (Z)', 'Octave up (X)', 'Reset octave to C4']) {
        expect(m.container.querySelector(`button[aria-label="${label}"]`)).toBeNull();
      }
      // Z and X play sounds 1 and 2 (they shift the octave only on a melodic part).
      const octave = uiStore.getState().keyboardOctave;
      // A = sound 5 (pad 4), 1 = sound 13 (pad 12); K and ";" are not kit keys and play nothing.
      for (const code of ['KeyZ', 'KeyX', 'KeyA', 'Digit1', 'KeyK', 'Semicolon']) {
        key(document.body, 'keydown', { key: 'x', code });
        key(document.body, 'keyup', { key: 'x', code });
      }
      expect(uiStore.getState().keyboardOctave).toBe(octave);
      expect(rec.played).toEqual(['on t1 0', 'off t1 0', 'on t1 1', 'off t1 1', 'on t1 4', 'off t1 4', 'on t1 12', 'off t1 12']);
    } finally {
      rec.restore();
    }
  });

  it('on a sampler part, says that Musical Assist leaves recordings at the key pressed', async () => {
    await appFonts();
    act(() => selectTrack('t8'));
    const m = strip();
    expect(m.container.textContent).toContain('Recordings play as pressed');
    expect(m.container.textContent).not.toContain('Snapping to');
    // The whole line is readable (it is not cut off with an ellipsis).
    const note = [...m.container.querySelectorAll<HTMLElement>('p[aria-live="polite"]')].find((p) => p.textContent?.startsWith('Recordings'))!;
    expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 1);
    act(() => selectTrack('t4'));
    expect(m.container.textContent).toContain('Snapping to');
  });
});

describe('Keyboard legends', () => {
  it('every key the computer plays shows its letter (A and K included); C keys and the root are named on the rail above the keys, never in a key', () => {
    const m = mount(h('div', { style: { width: '1340px', height: '100px' } }, h(KeyboardStrip)), { width: 1366 });
    const board = m.container.querySelector<HTMLElement>('[role="group"][aria-label^="Keyboard playing"]')!;
    const keys = [...board.querySelectorAll<HTMLElement>('[data-midi]')];
    // Two octaves, or three when the strip has room (this one does).
    expect([25, 37]).toContain(keys.length);
    const letter = (midi: number) => board.querySelector(`[data-midi="${midi}"] [class*="keycap"]`)?.textContent;
    // The default octave starts on C4 (60): A, W, S… up to ' (17 semitones up).
    expect(letter(60)).toBe('A');
    expect(letter(62)).toBe('S');
    expect(letter(72)).toBe('K');
    expect(letter(77)).toBe("'");
    // One legend per key at most, and never a note name in it.
    for (const k of keys) {
      const legend = k.lastElementChild!;
      expect(legend.children.length).toBeLessThanOrEqual(1);
      expect(k.querySelector('[class*="name"]')).toBeNull();
    }
    // The rail: C4, C5 and the root (G in the House starter), each above its key.
    const rail = [...board.querySelectorAll<HTMLElement>('[class*="railName"]')];
    expect(rail.map((r) => r.textContent)).toEqual(expect.arrayContaining(['C4', 'C5', 'G']));
    const c4 = rail.find((r) => r.textContent === 'C4')!;
    expect(c4.getBoundingClientRect().bottom).toBeLessThanOrEqual(board.querySelector<HTMLElement>('[data-midi="60"]')!.getBoundingClientRect().top + 0.5);
    // The letter sits below the scale dot (allowing for the 2 px of leading above the glyphs in its line box).
    for (const k of keys) {
      const dot = k.querySelector<HTMLElement>('[class*="dot"]');
      const cap = k.querySelector<HTMLElement>('[class*="keycap"]');
      if (!dot || !cap || /#/.test(k.dataset.note ?? '')) continue;
      expect(cap.getBoundingClientRect().top, k.dataset.note).toBeGreaterThanOrEqual(dot.getBoundingClientRect().bottom - 2);
    }
  });
});

describe('Preview notes (editors and the sound browser)', () => {
  it('play the exact pitch, skip the arpeggiator, and are never recorded; played notes go through both', () => {
    session.accepted(setArp(session.store, 't4', { enabled: true }));
    // No audio device here: stand in for the engine and transport the session drives.
    const s = session as unknown as { engine: unknown; transport: unknown; take: unknown };
    const saved = { engine: s.engine, transport: s.transport, take: s.take };
    const live: [string, Id, number][] = [];
    const arpHeld: [Id, number[]][] = [];
    s.engine = {
      liveNoteOn: (t: Id, p: number) => live.push(['on', t, p]),
      liveNoteOff: (t: Id) => live.push(['off', t, -1]),
      releaseLive: () => {},
    };
    s.transport = { playing: false, setArpHeld: (t: Id, pitches: number[]) => arpHeld.push([t, [...pitches]]), getPosition: () => ({ tick: 0 }), restoreSongGain: () => {} };
    const take = { events: [] as unknown[] };
    s.take = take;
    try {
      // House is in G dorian with Musical Assist on: F# (66) is outside the scale.
      expect(session.store.getState().assist).toBe(true);
      session.noteOn('t3', 66, 0.8, 'preview');
      expect(live).toEqual([['on', 't3', 66]]);
      session.noteOff('t3', 66, 'preview');
      // A played key is snapped into the scale.
      session.noteOn('t3', 66, 0.8, 'computer');
      expect(live[2][2]).not.toBe(66);
      session.noteOff('t3', 66, 'computer');
      expect(take.events.map((e) => (e as { type: string }).type)).toEqual(['noteOn', 'noteOff']);

      // With the arpeggiator on (Chords), a preview still sounds straight and never feeds the pattern.
      live.length = 0;
      arpHeld.length = 0;
      session.noteOn('t4', 60, 0.8, 'preview');
      expect(live).toEqual([['on', 't4', 60]]);
      expect(arpHeld).toEqual([]);
      session.noteOn('t4', 67, 0.8, 'computer');
      expect(arpHeld.at(-1)).toEqual(['t4', [67]]);
      session.noteOff('t4', 60, 'preview');
      session.noteOff('t4', 67, 'computer');
      expect(arpHeld.at(-1)).toEqual(['t4', []]);
      expect(take.events).toHaveLength(4);
    } finally {
      s.engine = saved.engine;
      s.transport = saved.transport;
      s.take = saved.take;
      act(() => patchRuntime({ held: {} }));
    }
  });
});
