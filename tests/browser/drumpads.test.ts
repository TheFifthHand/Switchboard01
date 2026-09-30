/**
 * Drums pad mode in real Chromium: layout, pad presses into the session,
 * releases, computer keys, held lighting, voice selection and the chooser
 * shown for a part that is not a drum kit.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { DrumPads } from '../../src/app/views/DrumPads';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { kitInfo } from '../../src/content/catalog';
import { createProject } from '../../src/project/factory';
import type { Id } from '../../src/project/types';
import { changeInstrumentSound } from '../../src/state/commands';
import { drumVoiceFor, selectDrumVoice, selectTrack, setPadMode, uiStore } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';

type Call = ['on', Id, number, number, string] | ['off', Id, number, string];

let calls: Call[] = [];
const realNoteOn = session.noteOn;
const realNoteOff = session.noteOff;

beforeEach(() => {
  calls = [];
  // Record what the pads ask the session to play (no audio device in these tests).
  session.noteOn = (trackId, pitch, velocity, source) => {
    calls.push(['on', trackId, pitch, velocity, source]);
  };
  session.noteOff = (trackId, pitch, source) => {
    calls.push(['off', trackId, pitch, source]);
  };
  session.store.replace(createProject({ name: 'Pads test' }), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {} });
    selectTrack('t1');
    selectDrumVoice('t1', 0);
    setPadMode('drums');
  });
});

afterEach(() => {
  cleanup();
  session.noteOn = realNoteOn;
  session.noteOff = realNoteOff;
  act(() => patchRuntime({ held: {} }));
});

function setup() {
  const m = mount(h('div', { style: { width: '960px', height: '560px' } }, h(DrumPads)), { width: 1000 });
  const pad = (voice: number) => m.container.querySelector<HTMLButtonElement>(`#drum-pad-${voice}`);
  return { m, pad };
}

function kitOf(trackId: Id): string {
  const inst = session.store.getState().tracks.find((t) => t.id === trackId)!.instrument;
  if (inst.kind !== 'drums') throw new Error('not a kit');
  return inst.kitId;
}

describe('Drums pad mode', () => {
  it('lays out the 16 kit sounds with pad 0 bottom-left, rows bottom-to-top, key hints and the kit name', () => {
    const { m, pad } = setup();
    const names = getKitVoiceNames(kitOf('t1'));
    const pads = [...m.container.querySelectorAll<HTMLButtonElement>('button[id^="drum-pad-"]')];
    expect(pads).toHaveLength(16);
    // Screen order: top row 12..15 first, bottom row 0..3 last.
    expect(pads.map((p) => Number(p.id.replace('drum-pad-', '')))).toEqual([12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]);
    for (let v = 0; v < 16; v++) expect(pad(v)!.textContent).toContain(names[v]);

    const r0 = pad(0)!.getBoundingClientRect();
    const r3 = pad(3)!.getBoundingClientRect();
    const r12 = pad(12)!.getBoundingClientRect();
    expect(r0.top).toBeGreaterThan(r12.top); // bottom row
    expect(Math.abs(r0.left - r12.left)).toBeLessThan(1); // left column
    expect(r3.left).toBeGreaterThan(r0.left);

    // Key legends match the computer-key layout.
    expect(pad(0)!.textContent).toMatch(/Z$/);
    expect(pad(12)!.textContent).toMatch(/1$/);
    expect(m.container.textContent).toContain(kitInfo(kitOf('t1'))!.name);
    expect(m.container.textContent).toMatch(/Tap pads or use keys 1–4, Q–R, A–F, Z–V/);
  });

  it('a pad press plays its voice with the strike velocity, selects it for step editing, and pointerup releases it', () => {
    const { pad } = setup();
    const before = session.store.getState();
    const p2 = pad(2)!;
    pointer(p2, 'pointerdown', pointIn(p2, 0.95));
    expect(calls).toHaveLength(1);
    const [kind, trackId, voice, velocity, source] = calls[0] as ['on', Id, number, number, string];
    expect([kind, trackId, voice, source]).toEqual(['on', 't1', 2, 'pad']);
    expect(velocity).toBeGreaterThan(0.9);
    expect(velocity).toBeLessThanOrEqual(1);
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(2);
    expect(pad(2)!.hasAttribute('data-selected')).toBe(true);
    expect(pad(0)!.hasAttribute('data-selected')).toBe(false);
    expect(pad(2)!.getAttribute('aria-label')).toContain('selected for step editing');

    pointer(p2, 'pointerup', pointIn(p2, 0.95));
    expect(calls[1]).toEqual(['off', 't1', 2, 'pad']);

    // Upper strikes are softer.
    const p5 = pad(5)!;
    pointer(p5, 'pointerdown', pointIn(p5, 0.05));
    pointer(p5, 'pointerup', pointIn(p5, 0.05));
    expect((calls[2] as ['on', Id, number, number, string])[3]).toBeLessThan(0.5);
    // Playing pads never edits the project.
    expect(session.store.getState()).toBe(before);
  });

  it('pointercancel releases the voice', () => {
    const { pad } = setup();
    const p9 = pad(9)!;
    pointer(p9, 'pointerdown', pointIn(p9));
    pointer(p9, 'pointercancel', pointIn(p9));
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['on', 't1', 9],
      ['off', 't1', 9],
    ]);
  });

  it('computer keys play the pads (Z = pad 0, 1 = pad 12) only in Drums mode', () => {
    setup();
    key(window, 'keydown', { code: 'KeyZ', key: 'z' });
    key(window, 'keyup', { code: 'KeyZ', key: 'z' });
    key(window, 'keydown', { code: 'Digit1', key: '1', shiftKey: true });
    key(window, 'keyup', { code: 'Digit1', key: '1' });
    expect(calls).toEqual([
      ['on', 't1', 0, 0.8, 'computer'],
      ['off', 't1', 0, 'computer'],
      ['on', 't1', 12, 1, 'computer'],
      ['off', 't1', 12, 'computer'],
    ]);
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(12);

    calls = [];
    act(() => setPadMode('loops'));
    key(window, 'keydown', { code: 'KeyX', key: 'x' });
    key(window, 'keyup', { code: 'KeyX', key: 'x' });
    expect(calls).toEqual([]);
  });

  it('a pad lights only while its voice is held on this part', () => {
    const { pad } = setup();
    expect(pad(5)!.dataset.state).toBe('ready');
    act(() => patchRuntime({ held: { t1: [5], t2: [7] } }));
    expect(pad(5)!.dataset.state).toBe('playing');
    expect(pad(7)!.dataset.state).toBe('ready');
    act(() => patchRuntime({ held: { t1: [] } }));
    expect(pad(5)!.dataset.state).toBe('ready');
  });

  it('the part switch changes which drum kit the pads play', () => {
    const { m, pad } = setup();
    const radio = m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label^="Percussion"]')!;
    expect(radio.getAttribute('aria-checked')).toBe('false');
    fire(radio, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().selectedTrackId).toBe('t2');
    const names = getKitVoiceNames(kitOf('t2'));
    expect(pad(0)!.textContent).toContain(names[0]);
    const p0 = pad(0)!;
    pointer(p0, 'pointerdown', pointIn(p0));
    pointer(p0, 'pointerup', pointIn(p0));
    expect(calls[0].slice(0, 3)).toEqual(['on', 't2', 0]);
  });

  it('a melodic part shows a chooser of the drum parts (and the Notes pads) instead of pads', () => {
    act(() => selectTrack('t3'));
    const { m, pad } = setup();
    expect(pad(0)).toBeNull();
    expect(m.container.textContent).toContain('These pads play a drum kit');
    expect(m.container.textContent).toContain('Bass is a bass synth.');
    const options = [...m.container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Play "]')].map((b) => b.getAttribute('aria-label'));
    expect(options.some((l) => l?.startsWith('Play Drums (part 1'))).toBe(true);
    expect(options.some((l) => l?.startsWith('Play Percussion (part 2'))).toBe(true);

    const drums = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Play Drums"]')!;
    fire(drums, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().selectedTrackId).toBe('t1');
    expect(pad(0)).not.toBeNull();
    // Keys work once a kit is chosen; no computer key reached the melodic part.
    expect(calls).toEqual([]);
  });

  it('with no drum kit in the project the chooser points to the Notes pads', () => {
    session.accepted(changeInstrumentSound(session.store, 't1', 'poly', 'poly-glass-keys'));
    session.accepted(changeInstrumentSound(session.store, 't2', 'poly', 'poly-short-pluck'));
    const { m } = setup();
    expect(m.container.textContent).toContain('No part in this project uses a drum kit yet');
    const notes = [...m.container.querySelectorAll('button')].find((b) => b.textContent?.includes('on Notes pads'))!;
    expect(notes.textContent).toBe('Play Drums on Notes pads');
    fire(notes, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().padMode).toBe('notes');
  });
});
