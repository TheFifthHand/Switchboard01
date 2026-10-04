/**
 * Drum patterning (PLAY-09): paint a drag across steps as one undo step,
 * fill a sound every beat / 8th / 16th, shift a sound with wrap, clear it.
 * Plus the wave-1 hand-off: note commands never write past the last scene.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { MAX_CLIP_BARS, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { createClip } from '../../src/state/commands/clips';
import { addRecordedNotes, clearNotesForPitch, duplicatePage, fillSound, paintSteps, pastePage, shiftSound, stepOfTick, toggleStep } from '../../src/state/commands/notes';
import { applyVariation } from '../../src/state/commands/variation';

const DRUMS = 't1';
const SNARE = 2;
const HAT = 4;

const notes = (store: ProjectStore, slot = 0) => store.getState().tracks[0].clips[slot]?.notes ?? [];
const steps = (store: ProjectStore, pitch: number, slot = 0) =>
  notes(store, slot)
    .filter((n) => n.pitch === pitch)
    .map((n) => stepOfTick(n.tick))
    .sort((a, b) => a - b);
const valid = (p: Project) => {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  return r.ok && r.warnings.length === 0;
};

describe('paint steps', () => {
  it('paints steps 1..8 of the snare as one undo step', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 1);
    const undoBefore = store.undoLabel();
    // A drag enters one step at a time; every call shares the drag's gesture id.
    for (let s = 0; s < 8; s++) expect(paintSteps(store, DRUMS, 0, SNARE, [s], true, 'paint-1')).toMatchObject({ changed: true, painted: 1 });
    expect(steps(store, SNARE)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(store.undoLabel()).toBe('Paint steps');
    store.undo();
    expect(steps(store, SNARE)).toEqual([]);
    expect(store.undoLabel()).toBe(undoBefore);
  });

  it('erases with a drag that starts on a lit step, leaves untouched steps alone, and creates a clip when painting on an empty slot', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(paintSteps(store, DRUMS, 1, HAT, [0, 2, 4, 6, 20], true, 'p')).toMatchObject({ changed: true, painted: 5 });
    expect(store.getState().tracks[0].clips[1]!.bars).toBe(2);
    expect(paintSteps(store, DRUMS, 1, HAT, [0, 1, 2], false, 'e')).toMatchObject({ changed: true, painted: 2 });
    expect(steps(store, HAT, 1)).toEqual([4, 6, 20]);
    expect(store.undoLabel()).toBe('Erase steps');
    // Nothing to do: no change, no step.
    expect(paintSteps(store, DRUMS, 1, HAT, [4], true, 'p2')).toMatchObject({ changed: false, painted: 0 });
    // Steps outside the clip are refused with nothing changed.
    const at = store.getState();
    expect(paintSteps(store, DRUMS, 1, HAT, [3, 32], true)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(paintSteps(store, DRUMS, 1, 16, [3], true)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
  });
});

describe('a paint drag on an empty slot', () => {
  it('grows the clip it created as the drag goes on, in the same undo step', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const before = store.undoLabel();
    expect(paintSteps(store, DRUMS, 2, HAT, [12], true, 'drag-x')).toMatchObject({ changed: true, painted: 1 });
    expect(store.getState().tracks[0].clips[2]!.bars).toBe(1);
    for (let s = 13; s <= 40; s++) expect(paintSteps(store, DRUMS, 2, HAT, [s], true, 'drag-x')).toMatchObject({ changed: true, painted: 1 });
    expect(store.getState().tracks[0].clips[2]!.bars).toBe(3);
    expect(steps(store, HAT, 2)).toHaveLength(29);
    expect(valid(store.getState())).toBe(true);
    // It stops at MAX_CLIP_BARS.
    expect(paintSteps(store, DRUMS, 2, HAT, [MAX_CLIP_BARS * 16], true, 'drag-x')).toMatchObject({ changed: false, reason: 'invalid' });
    store.undo();
    expect(store.getState().tracks[0].clips[2]).toBeNull();
    expect(store.undoLabel()).toBe(before);
  });

  it('keeps an existing clip at its length, and a new drag does not grow a clip made by an earlier one', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 1);
    expect(paintSteps(store, DRUMS, 0, HAT, [15], true, 'one')).toMatchObject({ changed: true });
    expect(paintSteps(store, DRUMS, 0, HAT, [16], true, 'one')).toMatchObject({ changed: false, reason: 'invalid' });
    paintSteps(store, DRUMS, 1, HAT, [0], true, 'two');
    store.endGesture();
    expect(paintSteps(store, DRUMS, 1, HAT, [20], true, 'three')).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState().tracks[0].clips[1]!.bars).toBe(1);
  });
});

describe('fill, shift and clear a sound', () => {
  it('fills a 2-bar clip with 8th-note hats, keeping hits already there', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 2);
    toggleStep(store, DRUMS, 0, 4, HAT, 0.3);
    const r = fillSound(store, DRUMS, 0, HAT, 2, { velocity: 0.6 });
    expect(r).toMatchObject({ changed: true, added: 15 });
    expect(steps(store, HAT)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);
    expect(notes(store).find((n) => n.tick === 96)!.velocity).toBe(0.3);
    expect(store.undoLabel()).toBe('Fill every 8th');
    expect(fillSound(store, DRUMS, 0, HAT, 2)).toMatchObject({ changed: false, added: 0 });
    expect(fillSound(store, DRUMS, 0, HAT, 3 as never)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(fillSound(store, DRUMS, 0, SNARE, 4)).toMatchObject({ changed: true, added: 8 });
    expect(valid(store.getState())).toBe(true);
  });

  it('shifts a sound a step later or earlier, wrapping round the loop', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 1);
    for (const s of [0, 4, 15]) toggleStep(store, DRUMS, 0, s, SNARE);
    toggleStep(store, DRUMS, 0, 15, HAT);
    expect(shiftSound(store, DRUMS, 0, SNARE, 1)).toMatchObject({ changed: true, moved: 3, dropped: 0 });
    expect(steps(store, SNARE)).toEqual([0, 1, 5]);
    expect(steps(store, HAT)).toEqual([15]);
    expect(store.undoLabel()).toBe('Shift sound later');
    expect(shiftSound(store, DRUMS, 0, SNARE, -1)).toMatchObject({ changed: true, moved: 3 });
    expect(steps(store, SNARE)).toEqual([0, 4, 15]);
    // Without wrap a hit leaving the clip is removed.
    expect(shiftSound(store, DRUMS, 0, SNARE, 1, false)).toMatchObject({ changed: true, moved: 2, dropped: 1 });
    expect(steps(store, SNARE)).toEqual([1, 5]);
    expect(shiftSound(store, DRUMS, 0, 9, 1)).toMatchObject({ changed: false, reason: 'empty' });
  });

  it('clears one sound and says how many hits went', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 1);
    fillSound(store, DRUMS, 0, HAT, 1);
    toggleStep(store, DRUMS, 0, 0, SNARE);
    expect(clearNotesForPitch(store, DRUMS, 0, HAT)).toMatchObject({ changed: true, removed: 16 });
    expect(steps(store, SNARE)).toEqual([0]);
  });
});

describe('clip slots and lengths (wave-1 hand-off, capability-07)', () => {
  it('refuses slot 5 on a 4-scene project in every note command, leaving the project valid and unchanged', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(store.getState().scenes).toHaveLength(4);
    createClip(store, DRUMS, 0, 1);
    toggleStep(store, DRUMS, 0, 0, 0);
    const at = store.getState();
    expect(toggleStep(store, DRUMS, 5, 0, 0)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(addRecordedNotes(store, 't5', 5, [{ tick: 0, pitch: 60, velocity: 0.8, duration: 24 }], { quantize: '1/16', mode: 'overdub' })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(paintSteps(store, DRUMS, 5, 0, [0], true)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(fillSound(store, DRUMS, 5, 0, 4)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(applyVariation(store, DRUMS, 5, 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
    expect(store.getState().tracks.every((t) => t.clips.length === 4)).toBe(true);
    expect(valid(store.getState())).toBe(true);
  });

  it('records, pastes and duplicates bars up to 8-bar clips', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    // A take running into bar 7 makes a 7-bar clip.
    const r = addRecordedNotes(store, 't5', 0, [{ tick: 384 * 6 + 10, pitch: 60, velocity: 0.8, duration: 24 }], { quantize: '1/16', mode: 'overdub' });
    expect(r.changed).toBe(true);
    expect(store.getState().tracks[4].clips[0]!.bars).toBe(7);
    // Bar 8 is a page a paste or duplicate can reach.
    expect(duplicatePage(store, 't5', 0, 6, 7).changed).toBe(true);
    expect(store.getState().tracks[4].clips[0]!.bars).toBe(MAX_CLIP_BARS);
    expect(pastePage(store, 't5', 0, 8, [{ tick: 0, pitch: 60, velocity: 1, duration: 24 }])).toMatchObject({ changed: false, message: 'Clips have at most 8 bars.' });
    // An empty slot toggled on step 100 gets a 7-bar clip.
    expect(toggleStep(store, DRUMS, 0, 100, 0).changed).toBe(true);
    expect(store.getState().tracks[0].clips[0]!.bars).toBe(7);
    expect(valid(store.getState())).toBe(true);
  });
});

describe('during a performance take', () => {
  it('refuses drum patterning like other clip edits', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    createClip(store, DRUMS, 0, 1);
    toggleStep(store, DRUMS, 0, 0, SNARE);
    store.setLock('Recording a performance', (label) => label.startsWith('module:'));
    const at = store.getState();
    expect(paintSteps(store, DRUMS, 0, SNARE, [1], true, 'g')).toMatchObject({ changed: false, refused: 'Recording a performance', painted: 0 });
    expect(fillSound(store, DRUMS, 0, HAT, 2)).toMatchObject({ changed: false, added: 0 });
    expect(shiftSound(store, DRUMS, 0, SNARE, 1)).toMatchObject({ changed: false, moved: 0 });
    expect(clearNotesForPitch(store, DRUMS, 0, SNARE)).toMatchObject({ changed: false, removed: 0 });
    expect(store.getState()).toBe(at);
  });
});
