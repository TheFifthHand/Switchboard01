/**
 * r6-start: the words and defaults a first-time user meets — the key in
 * everyday words, starter cards by mood and tempo, loops named after their
 * part, the keyboard folded in Song and Mix until it is needed, and the
 * "Try this" tour that starts at the step grid for a beat made from nothing.
 */
import { describe, expect, it } from 'vitest';
import { BLANK_STARTER, STARTERS } from '../../src/content/starters';
import { BEATS, realizeBeat } from '../../src/content/beats';
import { createClip as makeClip } from '../../src/project/factory';
import { createClip, setClipNotes } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { createUiStore, keyboardCollapsedFor, openKeyboardIfDefault, setKeyboardCollapsedFor } from '../../src/state/uiStore';
import { SCALE_MOOD, keyMood, keyReadout, starterFeel } from '../../src/app/views/keyMood';
import { HINT_STEPS, currentHint, drumsHaveNotes, type HintChange, type HintContext } from '../../src/app/views/hints/steps';
import { SCALE_ORDER } from '../../src/music/scales';
import type { RuntimeState } from '../../src/app/runtime';
import type { HistoryInfo } from '../../src/state/projectStore';

describe('the key in everyday words', () => {
  it('leads with the root and a mood; the scale’s own name stays for the tooltip', () => {
    expect(keyReadout(7, 'dorian')).toEqual({ text: 'Key: G · jazzy minor', name: 'G Dorian' });
    expect(keyMood(9, 'minor')).toBe('A · moody minor');
    expect(keyMood(5, 'phrygian')).toBe('F · dark minor');
    expect(keyMood(4, 'lydian')).toBe('E · dreamy major');
    expect(keyMood(0, 'chromatic')).toBe('Every note');
  });

  it('every scale has a mood, and none uses a theory word', () => {
    for (const id of SCALE_ORDER) {
      expect(SCALE_MOOD[id]).toBeTruthy();
      expect(SCALE_MOOD[id]).not.toMatch(/dorian|phrygian|lydian|mixolydian|pentatonic|harmonic/i);
    }
  });

  it('starter cards read mood, then tempo', () => {
    expect(starterFeel('warm, bouncy', 124)).toBe('warm, bouncy · 124 BPM');
    expect(starterFeel('lazy, dusty', 81.6)).toBe('lazy, dusty · 82 BPM');
  });
});

describe('new loops are named after their part', () => {
  it('"Drums 1", then "Drums 2"; another part counts on its own, so no two parts share a name', () => {
    const store = new ProjectStore(BLANK_STARTER.build());
    const p = store.getState();
    const drums = p.tracks.find((t) => t.instrument.kind === 'drums')!;
    const bass = p.tracks.find((t) => t.role === 'bass')!;
    expect(createClip(store, drums.id, 0, 1).changed).toBe(true);
    expect(createClip(store, drums.id, 1, 1).changed).toBe(true);
    expect(createClip(store, bass.id, 0, 2).changed).toBe(true);
    const names = (id: string) => store.getState().tracks.find((t) => t.id === id)!.clips.filter(Boolean).map((c) => c!.name);
    expect(names(drums.id)).toEqual([`${drums.name} 1`, `${drums.name} 2`]);
    expect(names(bass.id)).toEqual([`${bass.name} 1`]);
    // A name the part already uses is skipped; a name given is kept.
    expect(createClip(store, bass.id, 2, 1, 'My riff').changed).toBe(true);
    expect(createClip(store, bass.id, 3, 1).changed).toBe(true);
    expect(names(bass.id)).toEqual([`${bass.name} 1`, 'My riff', `${bass.name} 2`]);
  });
});

describe('the keyboard in Song and Mix', () => {
  it('starts folded there, and unfolds for a note or Record only when the fold was not chosen', () => {
    const ui = createUiStore(null);
    expect(keyboardCollapsedFor(ui.getState(), 'arrange')).toBe(true);
    expect(keyboardCollapsedFor(ui.getState(), 'mix')).toBe(true);
    expect(keyboardCollapsedFor(ui.getState(), 'play')).toBe(false);
    openKeyboardIfDefault('arrange', ui);
    expect(keyboardCollapsedFor(ui.getState(), 'arrange')).toBe(false);
    // Folded on purpose: a note does not bring it back.
    setKeyboardCollapsedFor('mix', true, ui);
    openKeyboardIfDefault('mix', ui);
    expect(keyboardCollapsedFor(ui.getState(), 'mix')).toBe(true);
  });
});

describe('the "Try this" tour for a beat from nothing', () => {
  const ctx = (over: Partial<HintContext> = {}): HintContext => ({ view: 'play', padMode: 'steps', bassName: 'Bass', drumsName: 'Drums', drumsMuted: false, recording: false, ...over });

  it('starts at the step grid in Steps; a starter whose drums already play leaves that step out', () => {
    const first = currentHint([], ctx({ hasClips: true, bassHasClips: false, drumsHasNotes: false }))!;
    expect(first.step.id).toBe('beat');
    expect(first.step.text(ctx())).toBe('Click squares in the grid to add Drums hits.');
    expect(first.step.here(ctx())).toBe(true);
    expect(first.step.here(ctx({ padMode: 'loops' }))).toBe(false);
    expect(currentHint([], ctx({ drumsHasNotes: true }))!.step.id).toBe('pad');
  });

  it('counts as done when a drum loop gets notes by an edit (a click, a beat picked), not by Undo', () => {
    const store = new ProjectStore(BLANK_STARTER.build());
    const drums = store.getState().tracks.find((t) => t.instrument.kind === 'drums')!;
    createClip(store, drums.id, 0, 1);
    const before = store.getState();
    expect(drumsHaveNotes(before)).toBe(false);
    const notes = realizeBeat(BEATS[0], { kitId: drums.instrument.kind === 'drums' ? drums.instrument.kitId : undefined }).notes.map((n, i) => ({ ...n, id: `n${i}` }));
    // The beat may be longer than the 1-bar loop: make it fit first.
    const bars = notes.reduce((m, n) => Math.max(m, Math.ceil((n.tick + 1) / 384)), 1);
    if (bars > 1) store.replace({ ...before, tracks: before.tracks.map((t) => (t.id === drums.id ? { ...t, clips: t.clips.map((c, i) => (i === 0 && c ? { ...c, bars: bars as 2 } : c)) } : t)) }, { resetHistory: false });
    const mid = store.getState();
    expect(setClipNotes(store, drums.id, 0, notes, 'Start from a beat').changed).toBe(true);
    const after = store.getState();
    expect(drumsHaveNotes(after)).toBe(true);
    const step = HINT_STEPS.find((s) => s.id === 'beat')!;
    const rt = {} as RuntimeState;
    const h = {} as HistoryInfo;
    const change = (edit: HintChange['edit']): HintChange => ({ source: 'project', project: after, prevProject: mid, history: h, prevHistory: h, runtime: rt, prevRuntime: rt, view: 'play', prevView: 'play', edit });
    expect(step.detect(change('edit'), {})).toBe(true);
    expect(step.detect(change('redo'), {})).toBe(false);
    expect(step.detect({ ...change('edit'), project: mid, prevProject: after }, {})).toBe(false);
  });

  it('the Record step names the transport’s Record and counts any recording that ends', () => {
    const step = HINT_STEPS.find((s) => s.id === 'record')!;
    expect(step.text(ctx())).toBe('Press Record, then play a few notes on the keyboard.');
    expect(step.text(ctx({ recording: true }))).toBe('Recording. Play a few notes, then press Record again to stop.');
    const p = STARTERS[0].build();
    const h = {} as HistoryInfo;
    const rt = (recording: RuntimeState['recording']) => ({ recording }) as RuntimeState;
    const c = (from: RuntimeState['recording'], to: RuntimeState['recording']): HintChange => ({ source: 'runtime', project: p, prevProject: p, history: h, prevHistory: h, runtime: rt(to), prevRuntime: rt(from), view: 'play', prevView: 'play' });
    expect(step.detect(c('notes', 'off'), {})).toBe(true);
    expect(step.detect(c('performance', 'off'), {})).toBe(true);
    expect(step.detect(c('off', 'notes'), {})).toBe(false);
  });

  it('a clip made by hand is not a beat until it has notes', () => {
    const p = BLANK_STARTER.build();
    const drums = p.tracks.find((t) => t.instrument.kind === 'drums')!;
    drums.clips[0] = makeClip('Drums 1', 1);
    expect(drumsHaveNotes(p)).toBe(false);
  });
});
