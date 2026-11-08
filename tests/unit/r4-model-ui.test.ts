/**
 * UI store additions: slots up to 8 scenes and pages up to 8 bars, a slot
 * chosen when a part is selected (PLAY-01), Steps follow and grid, chord
 * pads, the keyboard folded per view, the song lane's zoom per project and
 * copied effects. Remembered ones survive a reload; unknown keys are ignored.
 */
import { describe, expect, it } from 'vitest';
import {
  UI_STORAGE_KEY,
  createUiStore,
  ensureSelectedSlot,
  keyboardCollapsedFor,
  laneViewFor,
  selectSlot,
  setEffectClipboard,
  setKeyboardCollapsed,
  setKeyboardCollapsedFor,
  setLaneView,
  setNotesChords,
  setStepGrid,
  setStepPage,
  setStepsFollow,
  type KeyValueStorage,
} from '../../src/state/uiStore';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('uiStore v3 additions', () => {
  it('selects slots of up to 8 scenes and pages of up to 8 bars', () => {
    const ui = createUiStore(null);
    selectSlot('t1', 7, ui);
    selectSlot('t1', 8, ui);
    expect(ui.getState().selectedSlot).toEqual({ t1: 7 });
    setStepPage('t1', 7, ui);
    setStepPage('t1', 8, ui);
    expect(ui.getState().stepPage).toEqual({ t1: 7 });
  });

  it('ensureSelectedSlot chooses a slot only when none is chosen yet', () => {
    const ui = createUiStore(null);
    ensureSelectedSlot('t5', 2, ui);
    expect(ui.getState().selectedSlot.t5).toBe(2);
    ensureSelectedSlot('t5', 0, ui);
    expect(ui.getState().selectedSlot.t5).toBe(2);
    selectSlot('t5', 1, ui);
    expect(ui.getState().selectedSlot.t5).toBe(1);
  });

  it('remembers Steps follow, chord pads and the keyboard per view; not the step grid, lane view or copied effects', () => {
    const storage = memoryStorage();
    const ui = createUiStore(storage);
    expect(ui.getState()).toMatchObject({ stepsFollow: false, stepGrid: '1/16', notesChords: { on: false, size: 3 }, laneView: {}, effectClipboard: null });
    setStepsFollow(true, ui);
    setStepGrid('1/8T', ui);
    setStepGrid('1/5' as never, ui);
    setNotesChords({ on: true }, ui);
    setNotesChords({ size: 4 }, ui);
    setNotesChords({ size: 5 as never }, ui);
    setKeyboardCollapsedFor('play', true, ui);
    setLaneView('proj_a', { zoomStep: 3, scrollLeft: 174 }, ui);
    setLaneView('proj_a', { zoomStep: -1, scrollLeft: 5 }, ui);
    const clip = { from: 'Chords', effects: [{ type: 'eq' as const, params: { lowGain: -3 }, bypass: false }] };
    setEffectClipboard(clip, ui);
    clip.effects[0].params.lowGain = 9;
    const s = ui.getState();
    expect(s.stepGrid).toBe('1/8T');
    expect(s.notesChords).toEqual({ on: true, size: 4 });
    expect(laneViewFor(s, 'proj_a')).toEqual({ zoomStep: 3, scrollLeft: 174 });
    expect(laneViewFor(s, 'proj_b')).toBeNull();
    // The clipboard is a detached copy.
    expect(s.effectClipboard!.effects[0].params.lowGain).toBe(-3);

    const again = createUiStore(storage);
    expect(again.getState()).toMatchObject({ stepsFollow: true, notesChords: { on: true, size: 4 }, keyboardCollapsedByView: { play: true }, stepGrid: '1/16', laneView: {}, effectClipboard: null });
  });

  it('the keyboard starts folded in Mix; other views follow the old setting until set on their own', () => {
    const ui = createUiStore(null);
    expect(keyboardCollapsedFor(ui.getState(), 'mix')).toBe(true);
    expect(keyboardCollapsedFor(ui.getState(), 'play')).toBe(false);
    setKeyboardCollapsed(true, ui);
    expect(keyboardCollapsedFor(ui.getState(), 'shape')).toBe(true);
    setKeyboardCollapsedFor('shape', false, ui);
    setKeyboardCollapsedFor('mix', false, ui);
    expect(keyboardCollapsedFor(ui.getState(), 'shape')).toBe(false);
    expect(keyboardCollapsedFor(ui.getState(), 'mix')).toBe(false);
    expect(keyboardCollapsedFor(ui.getState(), 'arrange')).toBe(true);
  });

  it('ignores unknown and malformed remembered values', () => {
    const storage = memoryStorage({
      [UI_STORAGE_KEY]: JSON.stringify({ stepsFollow: 'yes', notesChords: { on: true, size: 7 }, keyboardCollapsedByView: { mix: false, nowhere: true, play: 'no' }, laneView: { p: 1 }, futureThing: 42 }),
    });
    const s = createUiStore(storage).getState();
    expect(s.stepsFollow).toBe(false);
    expect(s.notesChords).toEqual({ on: false, size: 3 });
    expect(s.keyboardCollapsedByView).toEqual({ mix: false });
    expect(s.laneView).toEqual({});
    expect('futureThing' in s).toBe(false);
  });
});
