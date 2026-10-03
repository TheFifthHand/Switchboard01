/**
 * Steps mode (StepEditor) in real Chromium: real pointer and keyboard events
 * on the mounted editor, checked against the project the session holds.
 */
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/ui/theme.css';
import { StepEditor } from '../../src/app/views/StepEditor';
import { barClipboard } from '../../src/app/views/steps/shared';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { createProject } from '../../src/project/factory';
import type { Clip, Note } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, selectSlot, selectTrack, setUiMode, uiStore } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, frames, key, mount, pointer, pointIn, wait } from './ui-harness';

const KICK = getKitVoiceNames('round-machine')[0];
const SNARE_VOICE = 2;
const SNARE = getKitVoiceNames('round-machine')[SNARE_VOICE];

let noteOn: ReturnType<typeof vi.spyOn>;
let noteOff: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  session.store.replace(createProject({ name: 'Steps test' }));
  uiStore.setState({ ...defaultUiState(), padMode: 'steps' });
  barClipboard.setState(null);
  // Audition goes through the session; keep the audio engine out of these tests.
  noteOn = vi.spyOn(session, 'noteOn').mockImplementation(() => {});
  noteOff = vi.spyOn(session, 'noteOff').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountEditor() {
  const m = mount(h('div', { style: { width: '960px', height: '470px', display: 'flex', flexDirection: 'column' } }, h(StepEditor)), { width: 1000 });
  return m;
}

function clip(trackId: string, slot = 0): Clip | null {
  return session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot] ?? null;
}

function notes(trackId: string, slot = 0): Note[] {
  return clip(trackId, slot)?.notes ?? [];
}

function byLabel(root: HTMLElement, start: string): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) => b.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No button labelled "${start}…"`);
  return el;
}

function buttonByText(root: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));
  if (!el) throw new Error(`No button with text ${String(text)}`);
  return el;
}

function press(el: Element, at = pointIn(el)) {
  pointer(el, 'pointerdown', at);
  pointer(el, 'pointerup', at);
}

function makeClip(trackId: string, bars: 1 | 2 | 3 | 4, slot = 0) {
  selectTrack(trackId);
  selectSlot(trackId, slot);
  expect(cmd.createClip(session.store, trackId, slot, bars).changed).toBe(true);
}

/* ------------------------------------------------------------------ */
/* Empty slot                                                          */
/* ------------------------------------------------------------------ */

describe('empty slot', () => {
  it('offers to create a 1, 2 or 4 bar clip right here', () => {
    selectTrack('t1');
    selectSlot('t1', 1);
    const m = mountEditor();
    expect(m.container.textContent).toContain('has no clip in');
    const create = buttonByText(m.container, '2-bar clip');
    create.focus();
    fire(create, new MouseEvent('click', { bubbles: true, detail: 0 }));
    const c = clip('t1', 1);
    expect(c?.bars).toBe(2);
    expect(c?.notes).toEqual([]);
    // The editor opens on the new clip, with a page per bar.
    expect(m.container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const step1 = byLabel(m.container, `Step 1, ${KICK}`);
    expect(step1.getAttribute('aria-label')).toBe(`Step 1, ${KICK}, off`);
    // Keyboard focus moves into the new clip's steps instead of being lost.
    expect(document.activeElement).toBe(step1);
  });

  it('a new melodic clip puts keyboard focus on the note grid', () => {
    selectTrack('t3');
    selectSlot('t3', 0);
    const m = mountEditor();
    fire(buttonByText(m.container, 'Create a 1-bar clip'), new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(clip('t3')?.bars).toBe(1);
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Note grid, bar 1\./);
  });

  it('with no slot chosen yet, opens the clip the part plays (else its first clip), not an empty slot', async () => {
    const scenes = session.store.getState().scenes;
    selectTrack('t1');
    cmd.createClip(session.store, 't1', 1, 1);
    cmd.createClip(session.store, 't1', 2, 1);
    patchRuntime({ playing: true, tracks: { t1: { playingSlot: 2, queued: null } } });
    try {
      const m = mountEditor();
      await actFrame();
      expect(m.container.textContent).not.toContain('has no clip in');
      // It becomes the part's selected slot, so Loops and Record Notes agree.
      expect(uiStore.getState().selectedSlot.t1).toBe(2);
      expect(m.container.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label')).toMatch(new RegExp(`^${scenes[2].name}: `));
    } finally {
      patchRuntime({ playing: false, tracks: {} });
    }
    cleanup();
    // Nothing playing: the first slot that holds a clip.
    uiStore.setState({ ...defaultUiState(), padMode: 'steps', selectedTrackId: 't1' });
    mountEditor();
    await actFrame();
    expect(uiStore.getState().selectedSlot.t1).toBe(1);
  });

  it('links to the part’s other clips', () => {
    makeClip('t1', 1, 2);
    selectSlot('t1', 0);
    const m = mountEditor();
    fire(byLabel(m.container, 'Edit '), new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().selectedSlot.t1).toBe(2);
    expect(m.container.textContent).not.toContain('has no clip in');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`Step 1, ${KICK}, off`);
  });
});

/* ------------------------------------------------------------------ */
/* Drums                                                               */
/* ------------------------------------------------------------------ */

describe('drum steps', () => {
  it('toggling a step adds and removes the note in the project', () => {
    makeClip('t1', 1);
    const m = mountEditor();
    const step5 = byLabel(m.container, `Step 5, ${KICK}`);
    pointer(step5, 'pointerdown', pointIn(step5));
    expect(notes('t1')).toHaveLength(1);
    expect(notes('t1')[0]).toMatchObject({ tick: 4 * 24, pitch: 0, velocity: 0.8 });
    expect(step5.getAttribute('aria-label')).toBe(`Step 5, ${KICK}, on, velocity 80%`);
    expect(step5.getAttribute('aria-pressed')).toBe('true');
    // The hit is auditioned on the kick voice.
    expect(noteOn).toHaveBeenCalledWith('t1', 0, 0.8, 'preview');

    pointer(step5, 'pointerdown', pointIn(step5));
    expect(notes('t1')).toHaveLength(0);
    expect(step5.getAttribute('aria-label')).toBe(`Step 5, ${KICK}, off`);
  });

  it('Space/Enter (a keyboard click) toggles the focused step; arrows move focus', () => {
    makeClip('t1', 1);
    const m = mountEditor();
    const step1 = byLabel(m.container, `Step 1, ${KICK}`);
    step1.focus();
    key(step1, 'keydown', { key: 'ArrowRight' });
    const step2 = byLabel(m.container, `Step 2, ${KICK}`);
    expect(document.activeElement).toBe(step2);
    expect(step2.tabIndex).toBe(0);
    expect(step1.tabIndex).toBe(-1);
    fire(step2, new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(notes('t1').map((n) => n.tick)).toEqual([24]);
  });

  it('choosing a kit sound changes which notes the lane edits', () => {
    makeClip('t1', 1);
    const m = mountEditor();
    const snareRow = m.container.querySelector<HTMLButtonElement>(`[data-voice="${SNARE_VOICE}"]`)!;
    fire(snareRow, new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(snareRow.closest('[role="row"]')?.getAttribute('aria-selected') ?? snareRow.getAttribute('aria-selected')).toBe('true');
    expect(noteOn).toHaveBeenLastCalledWith('t1', SNARE_VOICE, 0.8, 'preview');

    pointer(byLabel(m.container, `Step 3, ${SNARE}`), 'pointerdown', pointIn(byLabel(m.container, `Step 3, ${SNARE}`)));
    expect(notes('t1')).toEqual([expect.objectContaining({ tick: 48, pitch: SNARE_VOICE })]);
    // The overview row for the snare now shows the hit.
    expect(snareRow.querySelectorAll('[data-v="2"]')).toHaveLength(1);
    expect(snareRow.getAttribute('aria-label')).toContain('1 hit in bar 1');

    // Arrow keys in the sound list move the selection.
    snareRow.focus();
    key(snareRow, 'keydown', { key: 'ArrowUp' });
    expect(uiStore.getState().selectedDrumVoice.t1).toBe(1);
    expect(document.activeElement?.getAttribute('data-voice')).toBe('1');
  });

  it('Up/Down on a focused step and dragging the velocity lane change velocity (one undo step per drag)', () => {
    makeClip('t1', 1);
    const m = mountEditor();
    const step1 = byLabel(m.container, `Step 1, ${KICK}`);
    pointer(step1, 'pointerdown', pointIn(step1));
    step1.focus();
    key(step1, 'keydown', { key: 'ArrowDown' });
    key(step1, 'keydown', { key: 'ArrowDown' });
    expect(notes('t1')[0].velocity).toBeCloseTo(0.6, 5);
    expect(step1.getAttribute('aria-label')).toBe(`Step 1, ${KICK}, on, velocity 60%`);
    key(step1, 'keydown', { key: '+' });
    expect(notes('t1')[0].velocity).toBeCloseTo(0.7, 5);

    const lane = m.container.querySelector<HTMLElement>('[data-testid="velocity-lane"]')!;
    const col = lane.querySelector<HTMLElement>('[data-step="0"]')!;
    pointer(lane, 'pointerdown', pointIn(col, 0.9));
    pointer(lane, 'pointermove', pointIn(col, 0.5));
    pointer(lane, 'pointermove', pointIn(col, 0.08));
    pointer(lane, 'pointerup', pointIn(col, 0.08));
    const v = notes('t1')[0].velocity;
    expect(v).toBeGreaterThan(0.9);
    // The whole drag is one undo step.
    session.undo();
    expect(notes('t1')[0].velocity).toBeCloseTo(0.7, 5);
  });

  it('pages show the right bar; copy/paste, copy to next bar and clear work on the shown bar', async () => {
    makeClip('t1', 2);
    cmd.toggleStep(session.store, 't1', 0, 16, 0); // bar 2, step 1
    const m = mountEditor();
    const tabs = () => [...m.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['Bar 1', 'Bar 2']);
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(['1', '2']);
    expect(byLabel(m.container, `Step 1, ${KICK}`).getAttribute('aria-pressed')).toBe('false');

    fire(tabs()[1], new MouseEvent('click', { bubbles: true }));
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(byLabel(m.container, `Step 1, ${KICK}`).getAttribute('aria-pressed')).toBe('true');

    // Copy bar 2, paste onto bar 1.
    fire(byLabel(m.container, 'Copy bar'), new MouseEvent('click', { bubbles: true }));
    fire(tabs()[0], new MouseEvent('click', { bubbles: true }));
    fire(byLabel(m.container, 'Paste onto bar'), new MouseEvent('click', { bubbles: true }));
    expect(notes('t1').map((n) => n.tick).sort((a, b) => a - b)).toEqual([0, 384]);

    // Copy bar 1 to bar 2 → shows bar 2; then to bar 3 lengthens the clip.
    pointer(byLabel(m.container, `Step 9, ${KICK}`), 'pointerdown', pointIn(byLabel(m.container, `Step 9, ${KICK}`)));
    fire(buttonByText(m.container, 'To bar 2'), new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().stepPage.t1).toBe(1);
    expect(notes('t1').map((n) => n.tick).sort((a, b) => a - b)).toEqual([0, 192, 384, 576]);
    fire(buttonByText(m.container, 'To bar 3'), new MouseEvent('click', { bubbles: true }));
    expect(clip('t1')?.bars).toBe(3);
    expect(tabs()).toHaveLength(3);
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true');

    // Clear bar 3 (from the keyboard), then undo brings it back.
    const clearBtn = byLabel(m.container, 'Clear bar');
    clearBtn.focus();
    fire(clearBtn, new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(notes('t1').filter((n) => n.tick >= 768)).toHaveLength(0);
    // Clear switched itself off (the bar is empty): focus moves to the step pads.
    expect(clearBtn.disabled).toBe(true);
    await frames(2);
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(new RegExp(`^Step \\d+, ${KICK}, off$`));
    session.undo();
    expect(notes('t1').filter((n) => n.tick >= 768)).toHaveLength(2);
  });

  it('length, double and rename change the clip', () => {
    makeClip('t1', 1);
    cmd.toggleStep(session.store, 't1', 0, 2, 0);
    const m = mountEditor();
    fire(buttonByText(m.container, /Double$/), new MouseEvent('click', { bubbles: true }));
    expect(clip('t1')?.bars).toBe(2);
    expect(notes('t1').map((n) => n.tick).sort((a, b) => a - b)).toEqual([48, 432]);

    fire(m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="4 bars"]')!, new MouseEvent('click', { bubbles: true }));
    expect(clip('t1')?.bars).toBe(4);

    const input = m.container.querySelector<HTMLInputElement>('input[aria-label="Clip name"]')!;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'Floor Tom Fill');
    fire(input, new Event('input', { bubbles: true }));
    key(input, 'keydown', { key: 'Enter' });
    expect(clip('t1')?.name).toBe('Floor Tom Fill');
  });
});

/* ------------------------------------------------------------------ */
/* Melodic                                                             */
/* ------------------------------------------------------------------ */

describe('melodic pitch lane', () => {
  function setup() {
    makeClip('t3', 2); // bass
    const m = mountEditor();
    const roll = m.container.querySelector<HTMLElement>('[data-testid="pitch-roll"]')!;
    const cell = (step: number, pitch: number) => {
      const col = roll.querySelector<HTMLElement>(`[data-col="${step}"]`)!.getBoundingClientRect();
      const row = roll.querySelector<HTMLElement>(`[data-row-label="${pitch}"]`)!.getBoundingClientRect();
      return { clientX: col.left + col.width / 2, clientY: row.top + row.height / 2 };
    };
    return { m, roll, cell };
  }

  it('shows in-key rows with note names while Musical Assist is on, all semitones when off', () => {
    const { m, roll } = setup();
    // Default project: C minor (C4 = 60). C#/Db is not in the key.
    expect(roll.querySelector('[data-row-label="48"]')?.textContent).toContain('C3');
    expect(roll.querySelector('[data-row-label="48"]')?.hasAttribute('data-root')).toBe(true);
    expect(roll.querySelector('[data-row-label="49"]')).toBeNull();
    cmd.setAssist(session.store, false);
    return actFrame().then(() => {
      expect(m.container.querySelector('[data-row-label="49"]')).not.toBeNull();
    });
  });

  it('the note names play their pitch, but stay silent while a performance take records (the take could not keep it)', () => {
    const { roll } = setup();
    const name = roll.querySelector<HTMLElement>('[data-row-label="48"]')!;
    press(name);
    expect(noteOn).toHaveBeenCalledWith('t3', 48, 0.8, 'preview');
    noteOn.mockClear();
    patchRuntime({ recording: 'performance' });
    try {
      press(name);
      expect(noteOn).not.toHaveBeenCalled();
    } finally {
      patchRuntime({ recording: 'off' });
    }
    press(name);
    expect(noteOn).toHaveBeenCalledTimes(1);
  });

  it('click adds a one-step note (and plays it) and selects it; a click on a note selects it; a double-click removes it with Undo', () => {
    const { roll, cell } = setup();
    pointer(roll, 'pointerdown', cell(4, 48));
    pointer(roll, 'pointerup', cell(4, 48));
    expect(notes('t3')).toEqual([expect.objectContaining({ tick: 96, pitch: 48, duration: 24, velocity: 0.8 })]);
    expect(noteOn).toHaveBeenCalledWith('t3', 48, 0.8, 'preview');
    const noteEl = () => roll.querySelector<HTMLElement>('[data-note-id]')!;
    expect(noteEl().hasAttribute('data-selected')).toBe(true);

    // A second note: the selection moves to it. A click on the first selects it again and keeps it.
    press(roll, cell(8, 51));
    expect(notes('t3')).toHaveLength(2);
    const first = roll.querySelector<HTMLElement>(`[data-note-id="${notes('t3')[0].id}"]`)!;
    expect(first.hasAttribute('data-selected')).toBe(false);
    press(first, pointIn(first, 0.5, 0.3));
    expect(notes('t3')).toHaveLength(2);
    expect(roll.querySelector<HTMLElement>(`[data-note-id="${notes('t3')[0].id}"]`)!.hasAttribute('data-selected')).toBe(true);

    // Double-click: removed, with a message that offers Undo.
    const again = roll.querySelector<HTMLElement>(`[data-note-id="${notes('t3')[0].id}"]`)!;
    press(again, pointIn(again, 0.5, 0.3));
    expect(notes('t3')).toHaveLength(1);
    expect(runtimeStore.getState().notice?.text).toBe('Deleted 1 note.');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    session.undo();
    expect(notes('t3')).toHaveLength(2);
  });

  it('dragging on after adding draws a longer note; the right edge resizes; the body moves', () => {
    const { roll, cell } = setup();
    pointer(roll, 'pointerdown', cell(0, 48));
    pointer(roll, 'pointermove', cell(2, 48));
    pointer(roll, 'pointerup', cell(2, 48));
    expect(notes('t3')[0]).toMatchObject({ tick: 0, pitch: 48, duration: 72 });

    const handle = roll.querySelector<HTMLElement>('[data-note-id] [data-handle]')!;
    pointer(handle, 'pointerdown', pointIn(handle));
    pointer(roll, 'pointermove', cell(5, 48));
    pointer(roll, 'pointerup', cell(5, 48));
    expect(notes('t3')[0].duration).toBe(6 * 24);
    // One resize drag = one undo step.
    session.undo();
    expect(notes('t3')[0].duration).toBe(72);

    // Move: grab the note on its first step and drag it two steps right and up one in-key row (C3 -> D3).
    const noteEl = roll.querySelector<HTMLElement>('[data-note-id]')!;
    const from = cell(0, 48);
    pointer(noteEl, 'pointerdown', from);
    pointer(roll, 'pointermove', cell(2, 50));
    pointer(roll, 'pointerup', cell(2, 50));
    expect(notes('t3')[0]).toMatchObject({ tick: 48, pitch: 50, duration: 72 });
  });

  it('drawing past the right edge continues the note into the next bar', () => {
    const { roll, cell } = setup();
    const start = cell(14, 48);
    const last = roll.querySelector<HTMLElement>('[data-col="15"]')!.getBoundingClientRect();
    pointer(roll, 'pointerdown', start);
    // Two and a half columns beyond step 16.
    const beyond = { clientX: last.right + last.width * 2.5, clientY: start.clientY };
    pointer(roll, 'pointermove', beyond);
    pointer(roll, 'pointerup', beyond);
    const n = notes('t3')[0];
    expect(n.tick).toBe(14 * 24);
    expect(n.duration).toBe(5 * 24); // steps 15, 16 of bar 1 and 1-3 of bar 2
  });

  it('notes longer than a bar continue on the next page', async () => {
    const { m, roll } = setup();
    cmd.addNote(session.store, 't3', 0, { tick: 336, pitch: 48, velocity: 0.8, duration: 96 });
    await actFrame();
    let el = roll.querySelector<HTMLElement>('[data-note-id]')!;
    expect(el.hasAttribute('data-to-next')).toBe(true);
    fire([...m.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1], new MouseEvent('click', { bubbles: true }));
    el = m.container.querySelector<HTMLElement>('[data-testid="pitch-roll"] [data-note-id]')!;
    expect(el).not.toBeNull();
    expect(el.hasAttribute('data-from-prev')).toBe(true);
    expect(el.style.gridColumn).toBe('2 / 4'); // steps 1-2 of bar 2
  });

  it('velocity lane: with nothing selected it sets every note starting on a step; with a selection only the selected notes', () => {
    const { m, roll, cell } = setup();
    press(roll, cell(3, 48));
    press(roll, cell(3, 51));
    const lane = m.container.querySelector<HTMLElement>('[data-testid="velocity-lane"]')!;
    const col = lane.querySelector<HTMLElement>('[data-step="3"]')!;
    // The note just added is selected: one bar per voice, the selected one marked.
    expect(col.querySelectorAll('[data-voice-id]')).toHaveLength(2);
    expect(col.querySelectorAll('[data-voice-id][data-selected]')).toHaveLength(1);
    expect(col.textContent).toContain('1/2');
    pointer(lane, 'pointerdown', pointIn(col, 0.9));
    pointer(lane, 'pointerup', pointIn(col, 0.9));
    const byPitch = (p: number) => notes('t3').find((n) => n.pitch === p)!.velocity;
    expect(byPitch(51)).toBeLessThan(0.3);
    expect(byPitch(48)).toBe(0.8);
    // Escape clears the selection: the lane sets both.
    const cursor = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Note grid"]')!;
    key(cursor, 'keydown', { key: 'Escape' });
    expect(col.textContent).toContain('×2');
    pointer(lane, 'pointerdown', pointIn(col, 0.75));
    pointer(lane, 'pointerup', pointIn(col, 0.75));
    const vs = notes('t3').map((n) => n.velocity);
    expect(vs[0]).toBeLessThan(0.5);
    expect(vs[0]).toBe(vs[1]);
  });

  it('keyboard: Enter adds at the cursor (or selects the note there), Shift+Right lengthens, + raises velocity, Delete removes', () => {
    const { m } = setup();
    const cursor = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Note grid"]')!;
    cursor.focus();
    key(cursor, 'keydown', { key: 'Enter' });
    expect(notes('t3')).toHaveLength(1);
    const pitch = notes('t3')[0].pitch;
    expect(notes('t3')[0]).toMatchObject({ tick: 0, duration: 24 });
    key(cursor, 'keydown', { key: 'ArrowRight', shiftKey: true });
    expect(notes('t3')[0].duration).toBe(48);
    key(cursor, 'keydown', { key: '+' });
    expect(notes('t3')[0].velocity).toBeCloseTo(0.9, 5);
    expect(cursor.getAttribute('aria-label')).toContain('2 steps, velocity 90%');
    key(cursor, 'keydown', { key: 'ArrowUp' });
    key(cursor, 'keydown', { key: 'Enter' });
    expect(notes('t3')).toHaveLength(2);
    expect(notes('t3')[1].pitch).toBeGreaterThan(pitch);
    // Enter on a note selects it; Delete removes the selection.
    key(cursor, 'keydown', { key: 'Enter' });
    expect(notes('t3')).toHaveLength(2);
    expect(cursor.getAttribute('aria-label')).toContain('1 note selected');
    key(cursor, 'keydown', { key: 'Delete' });
    expect(notes('t3')).toHaveLength(1);
    expect(notes('t3')[0].pitch).toBe(pitch);
  });

  it('keyboard: moving past step 16 opens the next bar and announces its cell', async () => {
    const { m } = setup();
    const cursor = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Note grid"]')!;
    cursor.focus();
    key(cursor, 'keydown', { key: 'Enter' });
    const pitch = notes('t3')[0].pitch;
    // Bar 2, step 1 holds a softer note of the same pitch.
    cmd.addNote(session.store, 't3', 0, { tick: 384, pitch, velocity: 0.5, duration: 24 });
    await actFrame();
    key(cursor, 'keydown', { key: 'End' });
    key(cursor, 'keydown', { key: 'ArrowRight' });
    expect(uiStore.getState().stepPage.t3).toBe(1);
    const live = m.container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toMatch(/^Bar 2\. .+, step 1: note, 1 step, velocity 50%$/);
    const grid = m.container.querySelector<HTMLButtonElement>('button[aria-label^="Note grid"]')!;
    expect(grid.getAttribute('aria-label')).toMatch(/^Note grid, bar 2\. .+, step 1: note, 1 step, velocity 50%$/);
    expect(document.activeElement).toBe(grid);
  });

  it('leaving Steps in the middle of drawing a note releases its audition', async () => {
    const { m, roll, cell } = setup();
    pointer(roll, 'pointerdown', cell(2, 48));
    expect(noteOn).toHaveBeenCalledWith('t3', 48, 0.8, 'preview');
    expect(noteOff).not.toHaveBeenCalled();
    m.unmount();
    await wait(200);
    expect(noteOff).toHaveBeenCalledWith('t3', 48, 'preview');
  });

  it('transpose: a scale step under Musical Assist (Shift: an octave), with a toast; Advanced adds semitone keys', async () => {
    const { m, roll, cell } = setup();
    press(roll, cell(0, 48));
    // C minor: C3 up one step is D3.
    fire(byLabel(m.container, 'Transpose up a scale step'), new MouseEvent('click', { bubbles: true }));
    expect(notes('t3')[0].pitch).toBe(50);
    expect(runtimeStore.getState().notice?.text).toMatch(/ moved up one step\.$/);
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    fire(byLabel(m.container, 'Transpose down a scale step'), new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(notes('t3')[0].pitch).toBe(38);
    expect(runtimeStore.getState().notice?.text).toMatch(/ moved down an octave\.$/);
    // Simple mode has no semitone keys; Advanced keeps them, labelled as semitones.
    expect(() => byLabel(m.container, 'Transpose up a semitone')).toThrow();
    setUiMode('advanced');
    await actFrame();
    fire(byLabel(m.container, 'Transpose up a semitone'), new MouseEvent('click', { bubbles: true }));
    expect(notes('t3')[0].pitch).toBe(39);
    expect(runtimeStore.getState().notice?.text).toMatch(/ moved up one semitone\.$/);
    // Musical Assist off: semitones only.
    setUiMode('simple');
    cmd.setAssist(session.store, false);
    await actFrame();
    expect(() => byLabel(m.container, 'Transpose up a scale step')).toThrow();
    fire(byLabel(m.container, 'Transpose up a semitone'), new MouseEvent('click', { bubbles: true }));
    expect(notes('t3')[0].pitch).toBe(40);
  });
});

/* ------------------------------------------------------------------ */
/* Undo and playhead                                                   */
/* ------------------------------------------------------------------ */

describe('undo and playhead', () => {
  it('the global Undo restores step edits and the editor follows', async () => {
    makeClip('t1', 1);
    const m = mountEditor();
    const step1 = byLabel(m.container, `Step 1, ${KICK}`);
    pointer(step1, 'pointerdown', pointIn(step1));
    pointer(byLabel(m.container, `Step 2, ${KICK}`), 'pointerdown', pointIn(byLabel(m.container, `Step 2, ${KICK}`)));
    expect(notes('t1')).toHaveLength(2);
    session.undo();
    await actFrame();
    expect(notes('t1')).toHaveLength(1);
    expect(byLabel(m.container, `Step 2, ${KICK}`).getAttribute('aria-pressed')).toBe('false');
    session.undo();
    await actFrame();
    expect(notes('t1')).toHaveLength(0);
    session.redo();
    await actFrame();
    expect(byLabel(m.container, `Step 1, ${KICK}`).getAttribute('aria-pressed')).toBe('true');
  });

  it('while a performance take locks clips, the header says so and edits are refused', async () => {
    makeClip('t1', 1);
    const m = mountEditor();
    session.store.setLock('Recording a performance', () => false);
    try {
      await actFrame();
      expect(m.container.querySelector('[role="status"]')?.textContent).toContain('Locked while a performance records');
      const step1 = byLabel(m.container, `Step 1, ${KICK}`);
      pointer(step1, 'pointerdown', pointIn(step1));
      expect(notes('t1')).toHaveLength(0);
      // The notice takes the editing tools' place; name and length cannot change.
      expect(() => buttonByText(m.container, 'To bar 2')).toThrow();
      expect(m.container.querySelector<HTMLInputElement>('input[aria-label="Clip name"]')!.readOnly).toBe(true);
      fire(m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="2 bars"]')!, new MouseEvent('click', { bubbles: true }));
      expect(clip('t1')?.bars).toBe(1);
      // An empty slot of the part says so too, and its create buttons are off.
      fire(m.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label$=": empty"]')!, new MouseEvent('click', { bubbles: true }));
      expect(m.container.querySelector('[role="status"]')?.textContent).toContain('Stop the take to create a clip');
      expect(buttonByText(m.container, 'Create a 1-bar clip').disabled).toBe(true);
    } finally {
      session.store.setLock(null);
    }
  });

  it('lights the heard step from the transport position (DOM only, no re-render)', async () => {
    makeClip('t1', 2);
    const s = session as unknown as { transport: unknown; sequencer: unknown };
    const saved = { transport: s.transport, sequencer: s.sequencer };
    let tick = 384 + 5 * 24 + 3; // bar 2, step 6
    s.transport = {
      // What is scheduled runs ahead; the light follows what is heard.
      getPosition: () => ({ tick: tick + 96, bar: 0, beat: 0, step: 0, playing: true }),
      audibleTick: () => tick,
      clipPhase: (_id: string, out: { slot: number; startTick: number; lengthTicks: number }) => Object.assign(out, { slot: 0, startTick: 0, lengthTicks: 768 }),
    };
    s.sequencer = { getTrackState: () => ({ playing: { slot: 0, clipId: 'x', startTick: 0 }, queued: null }) };
    try {
      patchRuntime({ playing: true, tracks: { t1: { playingSlot: 0, queued: null } } });
      const m = mountEditor();
      const tabs = () => [...m.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      // The frame loop marks it within a few frames (more on a busy machine).
      for (let i = 0; i < 60 && !tabs()[1].hasAttribute('data-live'); i++) await frames(1);
      // Bar 2 is sounding: its page lamp is lit; bar 1 is shown, so no step is.
      expect(tabs()[1].hasAttribute('data-live')).toBe(true);
      expect(m.container.querySelectorAll('[data-playhead]')).toHaveLength(0);
      tick = 5 * 24 + 3 + 768; // loops: bar 1, step 6
      for (let i = 0; i < 60 && !tabs()[0].hasAttribute('data-live'); i++) await frames(1);
      const lit = [...m.container.querySelectorAll<HTMLElement>('[data-playhead]')];
      expect(lit.length).toBeGreaterThanOrEqual(2);
      expect(lit.every((el) => el.getAttribute('data-ph-step') === '5')).toBe(true);
      expect(tabs()[0].hasAttribute('data-live')).toBe(true);
    } finally {
      s.transport = saved.transport;
      s.sequencer = saved.sequencer;
      patchRuntime({ playing: false, tracks: {} });
    }
  });
});
