/**
 * Part and scene management in real Chromium: the part menu in a Loops
 * column header (rename, lock, change sound), the sound browser (choose a
 * kit / preset / recording, undo, preview through the session note path,
 * the current sound marked), the Part panel's sound selector, and renaming
 * a scene from its side button.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { LoopsGrid } from '../../src/app/views/LoopsGrid';
import { PartPanel } from '../../src/app/views/PartPanel';
import { SoundBrowser, previewNotesFor } from '../../src/app/views/SoundBrowser';
import { KITS, SYNTH_PRESETS } from '../../src/content/catalog';
import { getStarter } from '../../src/content/starters';
import type { Id, Instrument } from '../../src/project/types';
import { selectTrack, setPadMode, uiStore } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, wait } from './ui-harness';

type Call = ['on', Id, number, number, string] | ['off', Id, number, string];
let calls: Call[] = [];
const real = { noteOn: session.noteOn, noteOff: session.noteOff, startAudio: session.startAudio };

beforeEach(() => {
  calls = [];
  // No audio device in these tests: record what previews ask the session to play.
  session.noteOn = (trackId, pitch, velocity, source) => {
    calls.push(['on', trackId, pitch, velocity, source]);
  };
  session.noteOff = (trackId, pitch, source) => {
    calls.push(['off', trackId, pitch, source]);
  };
  session.startAudio = () => Promise.resolve(true);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off' });
    setPadMode('loops');
    selectTrack('t1');
  });
});

afterEach(() => {
  cleanup();
  session.noteOn = real.noteOn;
  session.noteOff = real.noteOff;
  session.startAudio = real.startAudio;
});

const track = (id: Id) => session.store.getState().tracks.find((t) => t.id === id)!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function click(el: Element) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}
function item(text: string): HTMLButtonElement {
  const found = [...menu()!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no menu item "${text}"`);
  return found;
}
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function soundIdOf(inst: Instrument): string | null {
  return inst.kind === 'drums' ? inst.kitId : inst.kind === 'sampler' ? inst.sampleId : inst.presetId;
}
function mountGrid() {
  return mount(h('div', { style: { width: '1000px', height: '560px', display: 'flex', flexDirection: 'column' } }, h(LoopsGrid)), { width: 1040 });
}
function option(name: string): HTMLElement {
  const found = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(name));
  if (!found) throw new Error(`no sound "${name}"`);
  return found;
}
function tab(name: string): HTMLElement {
  return [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name))!;
}

describe('Part menu', () => {
  it("renames a part from the column header's '⋯' menu; Undo restores the name", () => {
    mountGrid();
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="Options for part Bass"]')!;
    click(more);
    expect(menu()!.getAttribute('aria-label')).toBe('Part Bass');
    expect(uiStore.getState().selectedTrackId).toBe('t3');
    click(item('Rename part'));
    const input = dialog()!.querySelector('input')!;
    expect(input.value).toBe('Bass');
    typeInto(input, 'Sub Line');
    click(dialog()!.querySelector('button[type="submit"]')!);
    expect(track('t3').name).toBe('Sub Line');
    expect(document.querySelector('button[aria-label="Options for part Sub Line"]')).not.toBeNull();
    // Focus went back to the trigger.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Options for part Sub Line');
    act(() => session.undo());
    expect(track('t3').name).toBe('Bass');
  });

  it('an empty name is not accepted and Escape keeps the old one', () => {
    mountGrid();
    const main = document.querySelector<HTMLButtonElement>('button[aria-label^="Select Lead"]')!;
    act(() => main.focus());
    key(main, 'keydown', { key: 'F2' });
    const input = dialog()!.querySelector('input')!;
    typeInto(input, '   ');
    click(dialog()!.querySelector('button[type="submit"]')!);
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toMatch(/Type a name/);
    expect(track('t5').name).toBe('Lead');
    key(input, 'keydown', { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(track('t5').name).toBe('Lead');
    expect(document.activeElement).toBe(main);
  });

  it('right-click on a header opens the menu; Lock toggles the part lock', () => {
    mountGrid();
    const header = document.querySelector<HTMLButtonElement>('button[aria-label^="Select Chords"]')!.parentElement!;
    const r = header.getBoundingClientRect();
    fire(header, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 10 }));
    expect(menu()!.getAttribute('aria-label')).toBe('Part Chords');
    const lock = item('Lock against Variation');
    expect(lock.getAttribute('aria-checked')).toBe('false');
    click(lock);
    expect(track('t4').locked).toBe(true);
    expect(menu()).toBeNull();
  });

  it('Change sound opens the sound browser for that part; choosing a preset changes the instrument, Undo restores it', () => {
    mountGrid();
    click(document.querySelector('button[aria-label="Options for part Chords"]')!);
    click(item('Change sound'));
    expect(menu()).toBeNull();
    const d = dialog()!;
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    expect(d.textContent).toContain('Sound for Chords');
    const before = track('t4').instrument;
    expect(before.kind).toBe('poly');
    // Current sound is marked and focused.
    const current = d.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!;
    expect(current.textContent).toContain('Current');
    expect(document.activeElement).toBe(current);
    // Suggested presets for a chords part come first.
    const headings = [...d.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(headings[0]).toBe('Suggested for chords');
    const suggested = SYNTH_PRESETS.filter((p) => p.kind === 'poly' && p.roles.includes('chords')).map((p) => p.name);
    const firstGroup = [...d.querySelectorAll('[role="group"]')[0].querySelectorAll('[role="option"]')].map((o) => o.querySelector('span span:nth-child(2)')?.textContent);
    expect(firstGroup).toEqual(suggested);

    const target = SYNTH_PRESETS.find((p) => p.kind === 'poly' && p.id !== soundIdOf(before))!;
    click(option(target.name));
    expect(soundIdOf(track('t4').instrument)).toBe(target.id);
    // The dialog stays open, now marking the new sound.
    expect(dialog()).not.toBeNull();
    expect(option(target.name).getAttribute('aria-selected')).toBe('true');
    expect(dialog()!.textContent).toContain(`Now: ${target.name}`);
    act(() => session.undo());
    expect(soundIdOf(track('t4').instrument)).toBe(soundIdOf(before));
  });

  it('switching a synth part to a drum kit (and back with Undo) changes the instrument kind', () => {
    mount(h(SoundBrowser, { open: true, trackId: 't3', onClose: () => {} }));
    click(tab('Drum kits'));
    // The part has melody notes: the browser says what a kit will do with them.
    expect(dialog()!.textContent).toMatch(/drum kit plays only drum hits/);
    click(option(KITS[1].name));
    const inst = track('t3').instrument;
    expect(inst.kind).toBe('drums');
    expect(soundIdOf(inst)).toBe(KITS[1].id);
    act(() => session.undo());
    expect(track('t3').instrument.kind).toBe('bass');
  });

  it('Sampler tab lists built-in recordings and assigns one', () => {
    mount(h(SoundBrowser, { open: true, trackId: 't5', onClose: () => {} }));
    click(tab('Sampler'));
    expect(dialog()!.textContent).toContain('Nothing imported yet');
    click(option('Bell Hit'));
    const inst = track('t5').instrument;
    expect(inst.kind).toBe('sampler');
    expect(soundIdOf(inst)).toBe('builtin:bell-hit');
  });

  it('keyboard: arrows move between sounds, Enter chooses', () => {
    mount(h(SoundBrowser, { open: true, trackId: 't1', onClose: () => {} }));
    const current = document.activeElement as HTMLElement;
    expect(current.getAttribute('aria-selected')).toBe('true');
    key(current, 'keydown', { key: 'Home' });
    const first = document.activeElement as HTMLElement;
    expect(first.textContent).toContain(KITS[0].name);
    key(first, 'keydown', { key: 'ArrowRight' });
    const second = document.activeElement as HTMLElement;
    expect(second.textContent).toContain(KITS[1].name);
    key(second, 'keydown', { key: 'Enter' });
    expect(soundIdOf(track('t1').instrument)).toBe(KITS[1].id);
  });

  it('Preview plays the current sound through the session (a triad in the key for poly parts) and releases it on close', async () => {
    let open = true;
    const m = mount(h(SoundBrowser, { open, trackId: 't4', onClose: () => (open = false) }));
    const btn = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Preview')!;
    click(btn);
    await act(async () => {
      await wait(0);
    });
    const expected = previewNotesFor(session.store.getState(), 't4').notes.map((n) => n.pitch);
    expect(expected).toHaveLength(3);
    // Root, third and fifth of the project key, from middle C upwards.
    const p = session.store.getState();
    expect(expected[0]).toBe(60 + p.root);
    expect([3, 4]).toContain(expected[1] - expected[0]);
    expect(expected[2] - expected[0]).toBe(7);
    expect(calls.filter((c) => c[0] === 'on').map((c) => c[2])).toEqual(expected);
    expect(calls.every((c) => c[1] === 't4')).toBe(true);
    m.rerender(h(SoundBrowser, { open: false, trackId: 't4', onClose: () => {} }));
    expect(calls.filter((c) => c[0] === 'off').map((c) => c[2]).sort()).toEqual([...expected].sort());
  });

  it('with "Preview on choose" on, choosing a kit plays kick, snare and hat together', async () => {
    mount(h(SoundBrowser, { open: true, trackId: 't1', onClose: () => {} }));
    click(option(KITS[2].name));
    await act(async () => {
      await wait(0);
    });
    expect(calls.filter((c) => c[0] === 'on').map((c) => c[2])).toEqual([0, 2, 4]);
    // Released after a short hold.
    await act(async () => {
      await wait(500);
    });
    expect(calls.filter((c) => c[0] === 'off')).toHaveLength(3);
  });

  it('sound choices are refused (and explained) while a performance is recording', () => {
    act(() => patchRuntime({ recording: 'performance' }));
    session.store.setLock('Recording a performance: sound choices are locked.', () => false);
    try {
      mount(h(SoundBrowser, { open: true, trackId: 't4', onClose: () => {} }));
      expect(dialog()!.textContent).toMatch(/sound choices are locked/);
      const before = track('t4').instrument;
      click(option(SYNTH_PRESETS.find((p) => p.kind === 'poly' && p.id !== soundIdOf(before))!.name));
      expect(track('t4').instrument).toBe(before);
    } finally {
      session.store.setLock(null);
      act(() => patchRuntime({ recording: 'off' }));
    }
  });
});

describe('Part panel sound selector', () => {
  it('shows the current sound and opens the sound browser', () => {
    act(() => selectTrack('t3'));
    mount(h('div', { style: { width: '312px', height: '600px' } }, h(PartPanel)));
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label^="Sound:"]')!;
    expect(btn.textContent).toContain('Bass synth');
    click(btn);
    expect(dialog()!.textContent).toContain('Sound for Bass');
    // Bass synth tab is preselected for a bass part.
    expect(dialog()!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Bass synth');
    click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    expect(dialog()).toBeNull();
  });
});

describe('Scene rename', () => {
  it("renames a scene from its '⋯' menu; Undo restores it", () => {
    mountGrid();
    const scene = session.store.getState().scenes[2];
    click(document.querySelector(`button[aria-label="Options for scene ${scene.name}"]`)!);
    click(item('Rename scene'));
    const input = dialog()!.querySelector('input')!;
    typeInto(input, 'Rise');
    click(dialog()!.querySelector('button[type="submit"]')!);
    expect(session.store.getState().scenes[2].name).toBe('Rise');
    expect(document.querySelector('button[aria-label^="Launch scene Rise"]')).not.toBeNull();
    act(() => session.undo());
    expect(session.store.getState().scenes[2].name).toBe(scene.name);
  });

  it('F2 on a scene button opens the rename field; Shift+F10 opens the scene menu', () => {
    mountGrid();
    const scene = session.store.getState().scenes[0];
    const btn = document.querySelector<HTMLButtonElement>(`button[aria-label^="Launch scene ${scene.name}"]`)!;
    act(() => btn.focus());
    key(btn, 'keydown', { key: 'F2' });
    expect(dialog()!.querySelector('input')!.value).toBe(scene.name);
    key(dialog()!.querySelector('input')!, 'keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(btn);
    key(btn, 'keydown', { key: 'F10', shiftKey: true });
    expect(menu()!.getAttribute('aria-label')).toBe(`Scene ${scene.name}`);
    expect(item('Add to song')).toBeTruthy();
  });

  it('Add to song appends the scene to the arrangement', () => {
    mountGrid();
    const scene = session.store.getState().scenes[1];
    const before = session.store.getState().arrangement.blocks.length;
    click(document.querySelector(`button[aria-label="Options for scene ${scene.name}"]`)!);
    click(item('Add to song'));
    const blocks = session.store.getState().arrangement.blocks;
    expect(blocks).toHaveLength(before + 1);
    expect(blocks[blocks.length - 1].sceneId).toBe(scene.id);
  });
});
