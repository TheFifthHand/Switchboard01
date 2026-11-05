/**
 * The hint steps' detection, kept with their words in steps.ts (shell-14,
 * arrange-no-song-hints, shell-08, and the round-5 Song view): the song
 * track's steps are done by the real state (loops added to the song, a loop
 * stretched at its right edge, a loop moved, the song cursor moved, the song
 * playing while the Song view is open, a finished export), never by a split
 * or another project; with no clips the pad and drag steps are passed over;
 * once the song track was offered it comes first, then the basics.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../src/app/runtime';
import { HINT_STEPS, currentHint, hintWhere, type HintContext } from '../../src/app/views/hints/steps';
import { HINT_IDS, createHintsStore, showHintsAgain, startHints, startSongHints, type HintId } from '../../src/app/views/hints/hintsState';
import { watchHints } from '../../src/app/views/hints/tracker';
import { getStarter } from '../../src/content/starters';
import { ProjectStore } from '../../src/state/projectStore';
import { createStore } from '../../src/state/store';
import type { View } from '../../src/state/uiStore';

function runtime(): RuntimeState {
  // The song fields of the round-5 runtime (songCursor, a bar-range loop).
  return {
    audio: 'running', audioMessage: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, songLooping: false,
    tracks: {}, recording: 'off', recordTarget: null, countingIn: false, stalled: null, muteAll: false, preview: false, held: {}, notice: null,
  } as unknown as RuntimeState;
}

const D = 't1';

/** The House starter with an empty song and one Drums loop at bar 1 (made with plain recipes, as any edit would). */
function withLoop(store: ProjectStore): string {
  const clip = store.getState().tracks[0].clips.find((c) => c)!;
  store.apply('test:Song', (d) => {
    d.arrangement.regions = [{ id: 'r1', trackId: D, clipId: clip.id, start: 0, bars: clip.bars, offset: 0 }];
    d.arrangement.sections = [];
  });
  return clip.id;
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
  it('playing the song counts only while the Song view is open', () => {
    const { rt, view, seen } = setup();
    rt.setState((s) => ({ ...s, playing: true, mode: 'song' }));
    expect(seen).toEqual([]);
    view.setState('arrange');
    expect(seen).toEqual(['song-play']);
  });

  it('a loop added, stretched at its right edge, moved; a split or a trimmed start does not count', () => {
    const { store, seen } = setup();
    const clipId = withLoop(store);
    seen.length = 0;
    const bars = store.getState().arrangement.regions[0].bars;
    // A split: more loops, no more bars.
    store.apply('test:Split', (d) => {
      const r = d.arrangement.regions[0];
      if (r.bars < 2) r.bars = 2;
    });
    seen.length = 0;
    store.apply('test:Split', (d) => {
      const r = d.arrangement.regions[0];
      d.arrangement.regions.push({ ...r, id: 'r1b', start: r.start + 1, bars: r.bars - 1, offset: 1 });
      r.bars = 1;
    });
    expect(seen).toEqual([]);
    // Added: a second loop later on. The song had loops already, so the tour left "add a loop" out:
    // it is not counted (counting it would make the tour's total grow, 1/5 to 2/6).
    store.apply('test:Add', (d) => {
      d.arrangement.regions.push({ id: 'r2', trackId: D, clipId, start: 16, bars, offset: 0 });
    });
    expect(seen).toEqual([]);
    // A trimmed start is not a stretch.
    store.apply('test:Trim', (d) => {
      const r = d.arrangement.regions.find((x) => x.id === 'r2')!;
      r.start += 1;
      r.bars -= 1;
    });
    expect(seen).toEqual([]);
    store.apply('test:Stretch', (d) => {
      d.arrangement.regions.find((x) => x.id === 'r2')!.bars += 4;
    });
    expect(seen).toEqual(['song-stretch']);
    store.apply('test:Move', (d) => {
      d.arrangement.regions.find((x) => x.id === 'r2')!.start += 8;
    });
    expect(seen).toEqual(['song-stretch', 'song-move']);
  });

  it('a loop added to an empty song counts (the tour has that step then)', () => {
    const { store, seen } = setup();
    store.apply('test:Empty', (d) => {
      d.arrangement.regions = [];
      d.arrangement.sections = [];
    });
    seen.length = 0;
    withLoop(store);
    expect(seen).toEqual(['song-add']);
  });

  it('the song cursor moved (a click on the ruler), not Play or Stop setting it', () => {
    const { rt, seen } = setup();
    rt.setState((s) => ({ ...s, playing: true, mode: 'song', songCursor: 4 }) as RuntimeState);
    rt.setState((s) => ({ ...s, playing: false, mode: 'live', songCursor: 0 }) as RuntimeState);
    expect(seen).toEqual([]);
    rt.setState((s) => ({ ...s, songCursor: 8 }) as RuntimeState);
    expect(seen).toEqual(['song-ruler']);
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
  // r6: steps wait until they can be done (ready) instead of leaving the tour, so the total never changes mid-tour;
  // drums with no beat yet start at "Click squares…" (the beat step), which a starter's tour leaves out.
  it('without clips, the pad, mute and drag steps wait; the total stays as the tour began', () => {
    const blank = ctx({ hasClips: false, bassHasClips: false, drumsHasNotes: false });
    expect(currentHint([], blank)).toMatchObject({ step: { id: 'beat' }, position: 1, total: 8 });
    // A beat made (drums have notes now, a loop exists): the bass still has nothing to tap, so Mute comes next.
    const made = ctx({ hasClips: true, bassHasClips: false, drumsHasNotes: true });
    expect(currentHint(['beat'], made)).toMatchObject({ step: { id: 'mute' }, position: 2, total: 8 });
    // A starter: its drums already play, so the tour has the seven basics.
    expect(currentHint([], ctx())!).toMatchObject({ step: { id: 'pad' }, position: 1, total: 7 });
    // Nothing that can be done yet comes before what can: with no clips at all, Tone.
    expect(currentHint(['beat'], ctx({ hasClips: false, bassHasClips: false, drumsHasNotes: true }))).toMatchObject({ step: { id: 'tone' }, position: 2, total: 8 });
  });

  it('once offered, the song track comes first in the Song view; then the basics carry on', () => {
    const arrange = ctx({ view: 'arrange', hasRegions: false });
    expect(currentHint(['pad'], arrange, { song: true })!.step.id).toBe('song-add');
    // The loop added: the song has loops now, and the tour keeps its six steps.
    expect(currentHint(['pad', 'song-add'], ctx({ view: 'arrange' }), { song: true })).toMatchObject({ step: { id: 'song-stretch' }, position: 2, total: 6 });
    // A song full of loops (a starter) has no "drag a loop in" step: five song steps.
    expect(currentHint(['pad'], ctx({ view: 'arrange' }), { song: true })).toMatchObject({ step: { id: 'song-stretch' }, position: 1, total: 5 });
    const songDone: HintId[] = ['pad', 'song-add', 'song-stretch', 'song-move', 'song-ruler', 'song-play', 'song-export'];
    expect(currentHint(songDone, ctx(), { song: true })!.step.id).toBe('mute');
    expect(currentHint([...HINT_IDS], ctx(), { song: true })).toBeNull();
    // Each song step says where it is done.
    for (const s of HINT_STEPS.filter((x) => x.track === 'song' && x.id !== 'song-export')) {
      expect(s.here(ctx({ view: 'arrange' }))).toBe(true);
      expect(s.go).toMatchObject({ label: 'Open Song', view: 'arrange' });
    }
  });

  it('elsewhere the song track does not crowd out the view on screen: a basics step that can be done there comes first', () => {
    // In Play the song's next step (Arrange) waits while a basics step can be done in Play.
    expect(currentHint(['pad'], ctx(), { song: true })).toMatchObject({ step: { id: 'mute' }, position: 2, total: 7 });
    // In Mix: the mastering step.
    expect(currentHint(['pad', 'mute', 'drag', 'tone', 'instrument'], ctx({ view: 'mix' }), { song: true })!.step.id).toBe('master');
    // Nothing of the basics left to do in Play: the song step, collapsed to "Next, in Song".
    const basics = HINT_STEPS.filter((x) => x.track === 'basics').map((x) => x.id);
    expect(currentHint(basics, ctx({ hasRegions: false }), { song: true })!.step.id).toBe('song-add');
    expect(currentHint(basics, ctx(), { song: true })!.step.id).toBe('song-stretch');
  });

  // r6: the song steps wait (and still count) instead of leaving the tour, and Export waits for a song to export.
  it('in an empty song the steps about its loops wait: first add one; with no clips at all, a basics step that can be done comes first', () => {
    const empty = ctx({ view: 'arrange', hasRegions: false });
    expect(currentHint(['pad'], empty, { song: true })).toMatchObject({ step: { id: 'song-add' }, position: 1, total: 6 });
    const nothing = ctx({ view: 'arrange', hasRegions: false, hasClips: false, bassHasClips: false });
    // Nothing to drag in: the Record step (it can be done anywhere) comes first, never "Export" an empty song.
    expect(currentHint(['pad', 'mute', 'drag', 'tone', 'instrument', 'master'], nothing, { song: true })!.step.id).toBe('record');
    const exportStep = HINT_STEPS.find((x) => x.id === 'song-export')!;
    expect(exportStep.ready!(nothing)).toBe(false);
    expect(exportStep.ready!(ctx())).toBe(true);
  });

  it('a step done elsewhere names the view, or the pad tab when its view is open', () => {
    const pad = HINT_STEPS.find((x) => x.id === 'pad')!;
    // In Mix: "Next, in Play:". In Play on the Steps tab: "Next, in Loops:", not the view already open.
    expect(pad.here(ctx({ view: 'mix' }))).toBe(false);
    expect(hintWhere(pad.go!, ctx({ view: 'mix' }))).toBe('Next, in Play:');
    expect(pad.here(ctx({ padMode: 'steps' }))).toBe(false);
    expect(hintWhere(pad.go!, ctx({ padMode: 'steps' }))).toBe('Next, in Loops:');
    const song = HINT_STEPS.find((x) => x.id === 'song-play')!;
    expect(hintWhere(song.go!, ctx())).toBe('Next, in Song:');
  });

  it('while the pads play (Play is Pause), the song step points at Play the song instead', () => {
    const play = HINT_STEPS.find((x) => x.id === 'song-play')!;
    expect(play.text(ctx({ view: 'arrange' }))).toBe('Press Play to hear your song.');
    expect(play.text(ctx({ view: 'arrange', padsPlaying: true }))).toBe('Press Play the song instead, above the song, to hear it.');
    expect(play.more?.(ctx({ view: 'arrange', padsPlaying: true }))).toBe('Your pads stop, and the song plays from the playhead.');
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
