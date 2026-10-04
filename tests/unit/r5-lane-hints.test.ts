/**
 * The song's "Try this" steps are done only by the action they suggest, made
 * with the real song commands on a real project store: a stretch, a move or
 * loops added by an edit count; an Undo or Redo bringing a state back does
 * not, and neither does a section moved with its loops or an intro pushing
 * the song later. The first step says where Add loops is while the loop
 * browser is shut.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../src/app/runtime';
import { HINT_STEPS, type HintContext } from '../../src/app/views/hints/steps';
import type { HintId } from '../../src/app/views/hints/hintsState';
import { watchHints } from '../../src/app/views/hints/tracker';
import { getStarter } from '../../src/content/starters';
import { addIntro, addClipToSong, moveRegions, moveSection, removeRegions, resizeRegions } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { createStore } from '../../src/state/store';
import type { View } from '../../src/state/uiStore';

function runtime(): RuntimeState {
  return {
    audio: 'running', audioMessage: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, songLooping: false,
    tracks: {}, recording: 'off', recordTarget: null, countingIn: false, stalled: null, muteAll: false, preview: false, held: {}, notice: null,
    recordStartsAtTick: null, recordTargetAudible: true, starterReplaced: null,
  };
}

/** The House starter with two Drums loops (bars 1–4, 9–12) and a section over the first. */
function setup() {
  const store = new ProjectStore(getStarter('house')!.build());
  const clip = store.getState().tracks[0].clips.find((c) => c)!;
  store.replace(
    {
      ...store.getState(),
      arrangement: {
        ...store.getState().arrangement,
        regions: [
          { id: 'r1', trackId: 't1', clipId: clip.id, start: 0, bars: 4, offset: 0 },
          { id: 'r2', trackId: 't1', clipId: clip.id, start: 8, bars: 4, offset: 0 },
        ],
        sections: [{ id: 's1', name: 'Intro', start: 0, bars: 4 }],
      },
    },
    { resetHistory: true },
  );
  const seen: HintId[] = [];
  const stop = watchHints(
    { project: store, history: store.info, runtime: createStore<RuntimeState>(runtime()), view: createStore<View>('arrange'), lastChange: () => store.lastChange() },
    (id) => seen.push(id),
  );
  return { store, seen, stop, clip: clip.id };
}

const only = (seen: HintId[], id: HintId) => seen.filter((x) => x === id).length;

describe('done by the action, never by Undo, Redo or a side effect', () => {
  it('stretching a loop counts; Undo giving a carved loop its length back does not', () => {
    const { store, seen } = setup();
    // A move that carves r2 (r1 lands over bars 7–10): r2 starts later, shorter.
    moveRegions(store, ['r1'], 6);
    expect(only(seen, 'song-stretch')).toBe(0);
    store.undo();
    expect(only(seen, 'song-stretch')).toBe(0);
    store.redo();
    store.undo();
    expect(only(seen, 'song-stretch')).toBe(0);
    resizeRegions(store, ['r2'], 'end', 2);
    expect(only(seen, 'song-stretch')).toBe(1);
  });

  it('moving a loop counts; Undo of a move, a section moved with its loops, or an intro pushing the song later do not', () => {
    const { store, seen } = setup();
    moveSection(store, 's1', 16);
    expect(only(seen, 'song-move')).toBe(0);
    store.undo();
    expect(only(seen, 'song-move')).toBe(0);
    addIntro(store);
    expect(only(seen, 'song-move')).toBe(0);
    store.undo();
    moveRegions(store, ['r2'], 2);
    expect(only(seen, 'song-move')).toBe(1);
    store.undo();
    store.redo();
    expect(only(seen, 'song-move')).toBe(1);
  });

  it('loops added count; Undo of a delete bringing them back does not', () => {
    const { store, seen, clip } = setup();
    removeRegions(store, ['r2']);
    store.undo();
    expect(only(seen, 'song-add')).toBe(0);
    addClipToSong(store, 't1', clip, 20);
    expect(only(seen, 'song-add')).toBe(1);
  });
});

describe('the first song step', () => {
  const step = HINT_STEPS.find((s) => s.id === 'song-add')!;
  const ctx = (browserOpen: boolean): HintContext => ({ view: 'arrange', padMode: 'loops', bassName: 'Bass', drumsName: 'Drums', drumsMuted: false, recording: false, browserOpen });
  it('says where Add loops is while the browser is shut, and to drag from it while it is open', () => {
    expect(step.more!(ctx(false))).toBe('Press Add loops (top right), then drag one onto a part’s row.');
    expect(step.more!(ctx(true))).toBe('From Add loops, on the right, onto a part’s row.');
  });
});
