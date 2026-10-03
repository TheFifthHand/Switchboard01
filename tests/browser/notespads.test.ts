/**
 * Notes pad mode in real Chromium: the scale-aware layout, octave controls,
 * pad presses into the session and their releases, held lighting and the
 * chooser shown for a drum part.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { NotesPads } from '../../src/app/views/NotesPads';
import { noteName, pitchClass, scaleDegreesInRange } from '../../src/music/scales';
import { createProject } from '../../src/project/factory';
import type { Id } from '../../src/project/types';
import { setAssist, setKey } from '../../src/state/commands';
import { selectTrack, setNotesOctave, setPadMode, uiStore } from '../../src/state/uiStore';
import { PAD_KEY_VELOCITY } from '../../src/ui/components';
import { actFrame, cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';

type Call = ['on', Id, number, number, string] | ['off', Id, number, string];

let calls: Call[] = [];
const realNoteOn = session.noteOn;
const realNoteOff = session.noteOff;
const realStartAudio = session.startAudio;

beforeEach(() => {
  calls = [];
  // Record what the pads ask the session to play (no audio device in these tests).
  session.noteOn = (trackId, pitch, velocity, source) => {
    calls.push(['on', trackId, pitch, velocity, source]);
  };
  session.noteOff = (trackId, pitch, source) => {
    calls.push(['off', trackId, pitch, source]);
  };
  // Audio never starts here (the Drums tests cover a note played while it starts).
  session.startAudio = () => Promise.resolve(false);
  session.store.replace(createProject({ name: 'Notes test' }), {
    resetHistory: true,
  });
  session.accepted(setKey(session.store, 9, 'minor')); // A minor
  session.accepted(setAssist(session.store, true));
  act(() => {
    patchRuntime({ held: {} });
    selectTrack('t3'); // Bass
    setNotesOctave(3);
    setPadMode('notes');
  });
});

afterEach(() => {
  cleanup();
  session.noteOn = realNoteOn;
  session.noteOff = realNoteOff;
  session.startAudio = realStartAudio;
  act(() => patchRuntime({ held: {}, replayId: null }));
});

function setup() {
  const m = mount(h('div', { style: { width: '960px', height: '560px' } }, h(NotesPads)), { width: 1000 });
  const pad = (i: number) => m.container.querySelector<HTMLButtonElement>(`#note-pad-${i}`);
  const labels = () => Array.from({ length: 16 }, (_, i) => pad(i)?.textContent ?? null);
  const button = (label: string) => m.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true }));
  return { m, pad, labels, button, click };
}

describe('Notes pad mode', () => {
  it('with Musical Assist on, plays 16 consecutive in-scale notes from the octave, bottom-left first, roots marked', () => {
    const { m, pad, labels } = setup();
    const expected = scaleDegreesInRange(9, 'minor', 48, 16);
    expect(expected).toHaveLength(16);
    expect(labels()).toEqual(expected.map((p) => noteName(p)));
    // Pad 0 is bottom-left, pad 12 top-left.
    const r0 = pad(0)!.getBoundingClientRect();
    const r12 = pad(12)!.getBoundingClientRect();
    expect(r0.top).toBeGreaterThan(r12.top);
    expect(Math.abs(r0.left - r12.left)).toBeLessThan(1);

    const roots = expected.map((p, i) => [p, i] as const).filter(([p]) => pitchClass(p) === 9);
    expect(roots.length).toBeGreaterThanOrEqual(2);
    for (const [, i] of roots) {
      const cell = pad(i)!.parentElement!;
      expect(cell.hasAttribute('data-root')).toBe(true);
      expect(cell.textContent).toContain('Root');
      expect(pad(i)!.getAttribute('aria-label')).toContain('root note');
    }
    expect(pad(0)!.parentElement!.hasAttribute('data-root')).toBe(false);
    // design-17: a root is marked by a bold "Root" label and a dotted ink outline, never the teal of selection.
    const rootCell = pad(roots[0][1])!.parentElement!;
    const ring = getComputedStyle(rootCell, '::after');
    expect(ring.borderTopStyle).toBe('dotted');
    expect(ring.boxShadow).toBe('none');
    const mark = [...rootCell.querySelectorAll('span')].find((el) => el.textContent === 'Root')!;
    expect(Number(getComputedStyle(mark).fontWeight)).toBeGreaterThanOrEqual(700);
    expect(getComputedStyle(mark).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(m.container.textContent).toContain('Musical Assist: pads play only notes in A minor.');
    expect(m.container.textContent).toContain(`${noteName(expected[0])}–${noteName(expected[15])}`);
  });

  it('a pad press plays its pitch with the strike velocity; pointerup and pointercancel release it', () => {
    const { pad } = setup();
    const before = session.store.getState();
    const expected = scaleDegreesInRange(9, 'minor', 48, 16);
    const p4 = pad(4)!;
    pointer(p4, 'pointerdown', pointIn(p4, 0.9));
    pointer(p4, 'pointerup', pointIn(p4, 0.9));
    const p7 = pad(7)!;
    pointer(p7, 'pointerdown', pointIn(p7, 0.2));
    pointer(p7, 'pointercancel', pointIn(p7, 0.2));
    expect(calls.map((c) => (c[0] === 'on' ? [c[0], c[1], c[2], c[4]] : c))).toEqual([
      ['on', 't3', expected[4], 'pad'],
      ['off', 't3', expected[4], 'pad'],
      ['on', 't3', expected[7], 'pad'],
      ['off', 't3', expected[7], 'pad'],
    ]);
    const v1 = (calls[0] as ['on', Id, number, number, string])[3];
    const v2 = (calls[2] as ['on', Id, number, number, string])[3];
    expect(v1).toBeGreaterThan(v2);
    expect(session.store.getState()).toBe(before);
  });

  it('octave down/up move the layout by an octave and show the range', () => {
    const { m, pad, button, click } = setup();
    const range = () => m.container.querySelector('output')!.textContent;
    const at = (octave: number) => scaleDegreesInRange(9, 'minor', (octave + 1) * 12, 16);
    click(button('Pads octave up'));
    expect(uiStore.getState().notesOctave).toBe(4);
    expect(pad(0)!.textContent).toBe(noteName(at(4)[0]));
    expect(range()).toBe(`${noteName(at(4)[0])}–${noteName(at(4)[15])}`);
    const p0 = pad(0)!;
    pointer(p0, 'pointerdown', pointIn(p0));
    pointer(p0, 'pointerup', pointIn(p0));
    expect(calls[0].slice(0, 3)).toEqual(['on', 't3', 60]);

    click(button('Pads octave down'));
    click(button('Pads octave down'));
    expect(uiStore.getState().notesOctave).toBe(2);
    expect(pad(0)!.textContent).toBe('C2');
  });

  it('the top octave is limited so all 16 pads keep a note', () => {
    session.accepted(setKey(session.store, 9, 'minorPentatonic'));
    act(() => setNotesOctave(7));
    const { pad, button, click } = setup();
    // From C7 the MIDI range ends after 14 pentatonic notes, so the layout stays at C6.
    expect(scaleDegreesInRange(9, 'minorPentatonic', 96, 16).length).toBeLessThan(16);
    const top = scaleDegreesInRange(9, 'minorPentatonic', 84, 16);
    for (let i = 0; i < 16; i++) expect(pad(i)!.textContent).toBe(noteName(top[i]));
    expect(button('Pads octave up').disabled).toBe(true);
    // One step down from the shown octave, not from the remembered one.
    click(button('Pads octave down'));
    expect(uiStore.getState().notesOctave).toBe(5);
    expect(pad(0)!.textContent).toBe(noteName(scaleDegreesInRange(9, 'minorPentatonic', 72, 16)[0]));
  });

  it('with Musical Assist off, plays 16 chromatic semitones and shades notes outside the key', () => {
    session.accepted(setAssist(session.store, false));
    const { m, pad, labels } = setup();
    expect(labels()).toEqual(Array.from({ length: 16 }, (_, i) => noteName(48 + i)));
    expect(m.container.textContent).toContain('Chromatic: every semitone.');
    // C#3 is outside A minor; C3 and A3 are in it.
    expect(pad(1)!.parentElement!.hasAttribute('data-outside')).toBe(true);
    expect(pad(1)!.getAttribute('aria-label')).toContain('outside the key');
    expect(pad(0)!.parentElement!.hasAttribute('data-outside')).toBe(false);
    expect(pad(9)!.parentElement!.hasAttribute('data-root')).toBe(true);
    const p1 = pad(1)!;
    pointer(p1, 'pointerdown', pointIn(p1));
    pointer(p1, 'pointerup', pointIn(p1));
    expect(calls[0].slice(0, 3)).toEqual(['on', 't3', 49]);
  });

  it('releases the note that was struck even if the octave changes while it is held', () => {
    const { pad, button, click } = setup();
    const p0 = pad(0)!;
    pointer(p0, 'pointerdown', pointIn(p0));
    click(button('Pads octave up'));
    pointer(p0, 'pointerup', pointIn(p0));
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['on', 't3', 48],
      ['off', 't3', 48],
    ]);
  });

  it('a pad lights while its pitch is held on this part', () => {
    const { pad } = setup();
    const expected = scaleDegreesInRange(9, 'minor', 48, 16);
    act(() => patchRuntime({ held: { t3: [expected[5]], t4: [expected[6]] } }));
    expect(pad(5)!.dataset.state).toBe('playing');
    expect(pad(6)!.dataset.state).toBe('ready');
    act(() => patchRuntime({ held: { t3: [] } }));
    expect(pad(5)!.dataset.state).toBe('ready');
  });

  it('the part switch changes which part the pads play', () => {
    const { m, pad, click } = setup();
    const chords = m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label^="Chords"]')!;
    click(chords);
    expect(uiStore.getState().selectedTrackId).toBe('t4');
    const p0 = pad(0)!;
    pointer(p0, 'pointerdown', pointIn(p0));
    pointer(p0, 'pointerup', pointIn(p0));
    expect(calls[0].slice(0, 3)).toEqual(['on', 't4', 48]);
  });

  it('a drum part shows a chooser of the melodic parts instead of pads', () => {
    act(() => selectTrack('t1'));
    const { m, pad, click } = setup();
    expect(pad(0)).toBeNull();
    expect(m.container.textContent).toContain('These pads play notes on a melodic part');
    expect(m.container.textContent).toContain('Drums is a drum kit.');
    const options = [...m.container.querySelectorAll<HTMLButtonElement>('[aria-label="Melodic parts"] button')];
    expect(options).toHaveLength(6);
    click(options.find((b) => b.getAttribute('aria-label')!.startsWith('Play Lead'))!);
    expect(uiStore.getState().selectedTrackId).toBe('t5');
    expect(pad(0)).not.toBeNull();
    expect(calls).toEqual([]);
  });
  it('is one tab stop (bottom-left); arrow keys move and Space plays the focused note', () => {
    const { m, pad } = setup();
    const expected = scaleDegreesInRange(9, 'minor', 48, 16);
    const stops = [...m.container.querySelectorAll<HTMLButtonElement>('button[id^="note-pad-"]')].filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.id)).toEqual(['note-pad-0']);
    act(() => pad(0)!.focus());
    key(pad(0)!, 'keydown', { key: 'ArrowUp', code: 'ArrowUp' });
    key(pad(4)!, 'keydown', { key: 'End', code: 'End' });
    expect(document.activeElement).toBe(pad(7));
    expect(pad(7)!.tabIndex).toBe(0);
    expect(pad(0)!.tabIndex).toBe(-1);
    const down = key(pad(7)!, 'keydown', { key: 'Enter', code: 'Enter' });
    expect(down.defaultPrevented).toBe(true);
    key(pad(7)!, 'keyup', { key: 'Enter', code: 'Enter' });
    expect(calls).toEqual([
      ['on', 't3', expected[7], PAD_KEY_VELOCITY, 'pad'],
      ['off', 't3', expected[7], 'pad'],
    ]);
  });

  it('says when the part is muted and unmutes it', () => {
    session.setMute('t3', true);
    const { m, click } = setup();
    expect(m.container.textContent).toContain('Bass is muted');
    click([...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Unmute')!);
    expect(session.store.getState().tracks.find((t) => t.id === 't3')!.mute).toBe(false);
    expect(m.container.textContent).not.toContain('is muted');
  });

  it('pauses the pads while a performance replays', () => {
    const { m, pad } = setup();
    act(() => patchRuntime({ replayId: 'perf-1' }));
    expect(m.container.textContent).toContain('Replaying a performance');
    expect(pad(0)!.disabled).toBe(true);
    act(() => patchRuntime({ replayId: null }));
    expect(pad(0)!.disabled).toBe(false);
  });

  it('choosing a part in the chooser puts keyboard focus on the note pads', async () => {
    act(() => selectTrack('t1'));
    const { m, pad, click } = setup();
    const lead = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Play Lead"]')!;
    act(() => lead.focus());
    click(lead);
    await actFrame();
    expect(document.activeElement).toBe(pad(0));
  });
  it('arrow keys in the part switch change the part and keep keyboard focus there', () => {
    const { m } = setup();
    const bass = m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label^="Bass"]')!;
    act(() => bass.focus());
    key(bass, 'keydown', { key: 'ArrowRight', code: 'ArrowRight' });
    expect(uiStore.getState().selectedTrackId).toBe('t4');
    expect(document.activeElement).toBe(m.container.querySelector('[role="radio"][aria-label^="Chords"]'));
  });
});
