/**
 * The hint steps' detection, kept with their words in steps.ts (shell-14,
 * arrange-no-song-hints, shell-08): the song track's steps are done by the
 * real state (the song playing while Arrange is open, a block's repeats, a
 * block's parts, a finished export), never by a split, a join or another
 * project; with no clips the pad and drag steps are passed over; once the
 * song track was offered it comes first, then the basics.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../src/app/runtime';
import { HINT_STEPS, currentHint, hintWhere, type HintContext } from '../../src/app/views/hints/steps';
import { HINT_IDS, createHintsStore, showHintsAgain, startHints, startSongHints, type HintId } from '../../src/app/views/hints/hintsState';
import { watchHints } from '../../src/app/views/hints/tracker';
import { getStarter } from '../../src/content/starters';
import { setBlockPart, setBlockRepeats, splitBlock } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { createStore } from '../../src/state/store';
import type { View } from '../../src/state/uiStore';

function runtime(): RuntimeState {
  return {
    audio: 'running', audioMessage: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, songBlockId: null, songLoop: null, songLooping: false,
    tracks: {}, recording: 'off', recordTarget: null, countingIn: false, stalled: null, muteAll: false, preview: false, held: {}, notice: null,
  };
}

function setup() {
  const store = new ProjectStore(getStarter('house')!.build());
  const rt = createStore<RuntimeState>(runtime());
  const view = createStore<View>('play');
  const exports = createStore<number>(0);
  const seen: HintId[] = [];
  const stop = watchHints({ project: store, history: store.info, runtime: rt, view, exports }, (id) => seen.push(id));
  return { store, rt, view, exports, seen, stop };
}

const ctx = (over: Partial<HintContext> = {}): HintContext => ({ view: 'play', padMode: 'loops', bassName: 'Bass', drumsName: 'Drums', drumsMuted: false, recording: false, ...over });

describe('the song steps', () => {
  it('playing the song counts only while Arrange is open', () => {
    const { rt, view, seen } = setup();
    rt.setState((s) => ({ ...s, playing: true, mode: 'song' }));
    expect(seen).toEqual([]);
    view.setState('arrange');
    expect(seen).toEqual(['song-play']);
  });

  it('a block’s repeats and a block’s parts; a split or a join does not count', () => {
    const { store, seen } = setup();
    const b = store.getState().arrangement.blocks.find((x) => x.repeats >= 2)!;
    expect(splitBlock(store, b.id, 1).changed).toBe(true);
    expect(seen).toEqual([]);
    const first = store.getState().arrangement.blocks[0];
    expect(setBlockRepeats(store, first.id, first.repeats + 1).changed).toBe(true);
    expect(seen).toEqual(['song-repeats']);
    expect(setBlockPart(store, first.id, 't1', null).changed).toBe(true);
    expect(seen).toEqual(['song-repeats', 'song-part']);
  });

  it('a finished export; another project counts as nothing', () => {
    const { store, exports, seen } = setup();
    exports.setState(1);
    expect(seen).toEqual(['song-export']);
    store.replace(getStarter('techno')!.build());
    expect(seen).toEqual(['song-export']);
  });
});

describe('which step comes next', () => {
  it('without clips, the pad and drag steps are passed over', () => {
    const blank = ctx({ hasClips: false, bassHasClips: false });
    const first = currentHint([], blank)!;
    expect(first.step.id).toBe('mute');
    expect(first).toMatchObject({ position: 1, total: 5 });
    expect(currentHint([], ctx())!).toMatchObject({ position: 1, total: 7 });
  });

  it('once offered, the song track comes first in Arrange; then the basics carry on', () => {
    const arrange = ctx({ view: 'arrange' });
    expect(currentHint(['pad'], arrange, { song: true })!.step.id).toBe('song-play');
    expect(currentHint(['pad', 'song-play'], arrange, { song: true })).toMatchObject({ position: 2, total: 4 });
    const songDone: HintId[] = ['pad', 'song-play', 'song-repeats', 'song-part', 'song-export'];
    expect(currentHint(songDone, ctx(), { song: true })!.step.id).toBe('mute');
    expect(currentHint([...HINT_IDS], ctx(), { song: true })).toBeNull();
    // Each song step says where it is done.
    for (const s of HINT_STEPS.filter((x) => x.track === 'song' && x.id !== 'song-export')) {
      expect(s.here(ctx({ view: 'arrange' }))).toBe(true);
      expect(s.go).toMatchObject({ label: 'Open Arrange', view: 'arrange' });
    }
  });

  it('elsewhere the song track does not crowd out the view on screen: a basics step that can be done there comes first', () => {
    // In Play the song's next step (Arrange) waits while a basics step can be done in Play.
    expect(currentHint(['pad'], ctx(), { song: true })).toMatchObject({ step: { id: 'mute' }, position: 2, total: 7 });
    // In Mix: the mastering step.
    expect(currentHint(['pad', 'mute', 'drag', 'tone', 'instrument'], ctx({ view: 'mix' }), { song: true })!.step.id).toBe('master');
    // Nothing of the basics left to do in Play: the song step, collapsed to "Next, in Arrange".
    const basics = HINT_STEPS.filter((x) => x.track === 'basics').map((x) => x.id);
    expect(currentHint(basics, ctx(), { song: true })!.step.id).toBe('song-play');
  });

  it('in a song with no blocks, the song steps about blocks are passed over', () => {
    const empty = ctx({ view: 'arrange', hasBlocks: false });
    expect(currentHint(['pad'], empty, { song: true })!.step.id).toBe('song-export');
    expect(currentHint(['pad'], empty, { song: true })).toMatchObject({ position: 1, total: 1 });
  });

  it('a step done elsewhere names the view, or the pad tab when its view is open', () => {
    const pad = HINT_STEPS.find((x) => x.id === 'pad')!;
    // In Mix: "Next, in Play:". In Play on the Steps tab: "Next, in Loops:", not the view already open.
    expect(pad.here(ctx({ view: 'mix' }))).toBe(false);
    expect(hintWhere(pad.go!, ctx({ view: 'mix' }))).toBe('Next, in Play:');
    expect(pad.here(ctx({ padMode: 'steps' }))).toBe(false);
    expect(hintWhere(pad.go!, ctx({ padMode: 'steps' }))).toBe('Next, in Loops:');
    const song = HINT_STEPS.find((x) => x.id === 'song-play')!;
    expect(hintWhere(song.go!, ctx())).toBe('Next, in Arrange:');
  });

  it('while the pads play (Play is Pause), the song step points at a block’s ▶ instead', () => {
    const play = HINT_STEPS.find((x) => x.id === 'song-play')!;
    expect(play.text(ctx({ view: 'arrange' }))).toBe('Press Play to hear your song.');
    expect(play.text(ctx({ view: 'arrange', padsPlaying: true }))).toBe('Press ▶ on a block to hear your song from there.');
    expect(play.more?.(ctx({ view: 'arrange', padsPlaying: true }))).toBe('Or Stop, then Play (or Space) plays the blocks in order.');
  });

  it('the song track is offered once while the hints run, and again after Show hints again', () => {
    const s = createHintsStore(null);
    startSongHints(s);
    expect(s.getState().song).toBe(false);
    startHints(s);
    startSongHints(s);
    expect(s.getState().song).toBe(true);
    showHintsAgain(s);
    expect(s.getState().song).toBe(false);
  });
});
