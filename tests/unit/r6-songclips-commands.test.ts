/**
 * Song clips (schema v5): loops only the song plays. New commands (add a
 * loop, make a copy different, copy to a pad, record into the song), the
 * clip commands working on song slots, the pad-grid commands refusing them,
 * and song clips leaving the part once no loop in the song plays them.
 */
import { describe, expect, it } from 'vitest';
import { PROGRESSIONS } from '../../src/music/chords';
import { clipAtSlot, songSlot } from '../../src/project/clips';
import { MAX_SONG_BARS, MAX_SONG_CLIPS, TICKS_PER_BAR, type Id, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import * as cmd from '../../src/state/commands';
import type { ProjectStore } from '../../src/state/projectStore';
import { expectRefused, songStore } from './r5-song-fixtures';

const note = (tick: number, pitch = 48, duration = 24) => ({ tick, pitch, velocity: 0.8, duration });

/** The song's loops in words, song clips included: "t3:Bass 1@0+4~0". */
function sketch(p: Project): string[] {
  const name = (trackId: Id, clipId: Id) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return [...(t?.clips ?? []), ...(t?.songClips ?? [])].find((c) => c?.id === clipId)?.name ?? '?';
  };
  return p.arrangement.regions.map((r) => `${r.trackId}:${name(r.trackId, r.clipId)}@${r.start}+${r.bars}~${r.offset}`);
}

const songNames = (p: Project, trackId: Id) => (p.tracks.find((t) => t.id === trackId)?.songClips ?? []).map((c) => c.name);

/** Valid as it is: validation repairs nothing, and the song and every part's song clips come back unchanged. */
function expectValid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.warnings).toEqual([]);
  expect(r.project.arrangement).toEqual(JSON.parse(JSON.stringify(p.arrangement)));
  expect(r.project.tracks.map((t) => t.songClips)).toEqual(JSON.parse(JSON.stringify(p.tracks.map((t) => t.songClips ?? null))).map((x: unknown) => x ?? undefined));
}

/** The same project, the last-edit time aside. */
function expectSame(a: Project, b: Project): void {
  expect({ ...a, updatedAt: 0 }).toEqual({ ...b, updatedAt: 0 });
}

function fresh(): { store: ProjectStore; clip: Record<string, Id> } {
  const s = songStore();
  s.store.clearHistory();
  return s;
}

describe('addLoopToSong', () => {
  it('adds a song clip and a loop of its length; the default names count up; Undo and Redo', () => {
    const { store } = fresh();
    const before = store.getState();
    const a = cmd.addLoopToSong(store, 't3', 4, { bars: 2, notes: [note(0), note(96, 50)] });
    expect(a).toMatchObject({ changed: true, slot: songSlot(0) });
    const p = store.getState();
    expect(sketch(p)).toEqual(['t3:Bass 1@4+2~0']);
    expect(clipAtSlot(p.tracks[2], a.slot!)?.notes).toHaveLength(2);
    expect(p.tracks[2].clips).toEqual(before.tracks[2].clips);
    expect(store.undoLabel()).toBe('Add Bass 1');
    const b = cmd.addLoopToSong(store, 't3', 8, { bars: 1 });
    expect(b.changed).toBe(true);
    expect(songNames(store.getState(), 't3')).toEqual(['Bass 1', 'Bass 2']);
    expect(clipAtSlot(store.getState().tracks[2], b.slot!)?.notes).toEqual([]);
    expectValid(store.getState());
    store.undo();
    store.undo();
    expectSame(store.getState(), before);
    store.redo();
    expect(sketch(store.getState())).toEqual(['t3:Bass 1@4+2~0']);
  });

  it('a name is kept; the bar is kept inside the song; the new loop wins over what was there', () => {
    const { store, clip } = fresh();
    cmd.addRegions(store, [{ trackId: 't3', clipId: clip.Bounce, start: 0, bars: 8 }]);
    const r = cmd.addLoopToSong(store, 't3', 2, { name: '  Deep  Line ', bars: 2 }, { display: 'Add Deep Line from the library' });
    expect(r.changed).toBe(true);
    expect(store.undoLabel()).toBe('Add Deep Line from the library');
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+2~0', 't3:Deep Line@2+2~0', 't3:Bounce@4+4~0']);
    cmd.addLoopToSong(store, 't3', MAX_SONG_BARS + 50, { bars: 4 });
    expect(store.getState().arrangement.regions.at(-1)).toMatchObject({ start: MAX_SONG_BARS - 4, bars: 4 });
    expectValid(store.getState());
  });

  it('notes the part cannot play are left out', () => {
    const { store } = fresh();
    const r = cmd.addLoopToSong(store, 't1', 0, { bars: 1, notes: [note(0, 2), note(24, 90), note(TICKS_PER_BAR * 3, 1)] });
    expect(clipAtSlot(store.getState().tracks[0], r.slot!)?.notes.map((n) => n.pitch)).toEqual([2]);
  });

  it('refuses bad input and a full part with nothing changed', () => {
    const { store } = fresh();
    expectRefused(store, () => cmd.addLoopToSong(store, 'nope', 0, { bars: 1 }), 'not-found');
    expectRefused(store, () => cmd.addLoopToSong(store, 't3', 0, { bars: 3.5 as 1 }), 'invalid');
    expectRefused(store, () => cmd.addLoopToSong(store, 't3', Number.NaN, { bars: 1 }), 'invalid');
    store.apply('test:fill', (d) => {
      d.tracks[2].songClips = Array.from({ length: MAX_SONG_CLIPS }, (_, i) => ({ id: `sc${i}`, name: `L${i}`, bars: 1, notes: [] }));
    });
    expectRefused(store, () => cmd.addLoopToSong(store, 't3', 0, { bars: 1 }), 'limit');
  });
});

describe('song clips leave the part when no loop plays them', () => {
  it('deleting the last loop of a song clip deletes the clip in the same step; Undo restores both', () => {
    const { store } = fresh();
    const a = cmd.addLoopToSong(store, 't3', 0, { bars: 1 });
    cmd.addRegions(store, [{ trackId: 't3', clipId: a.clipId!, start: 4, bars: 2 }]);
    const two = store.getState();
    const [first, second] = two.arrangement.regions.map((r) => r.id);
    cmd.removeRegions(store, [first]);
    expect(songNames(store.getState(), 't3')).toEqual(['Bass 1']);
    cmd.removeRegions(store, [second]);
    expect(store.getState().tracks[2].songClips).toBeUndefined();
    expectValid(store.getState());
    store.undo();
    expect(songNames(store.getState(), 't3')).toEqual(['Bass 1']);
    store.undo();
    expectSame(store.getState(), two);
  });

  it('a loop placed over another song clip’s only loop takes that clip with it', () => {
    const { store } = fresh();
    cmd.addLoopToSong(store, 't3', 0, { bars: 2 });
    cmd.addLoopToSong(store, 't3', 0, { bars: 2 });
    expect(songNames(store.getState(), 't3')).toEqual(['Bass 2']);
    expect(sketch(store.getState())).toEqual(['t3:Bass 2@0+2~0']);
    expect(store.getState().tracks[2].songClips?.length).toBe(1);
  });

  it('clearing the song, or removing the bars, takes the song clips too', () => {
    const { store } = fresh();
    cmd.addLoopToSong(store, 't3', 0, { bars: 2 });
    cmd.addLoopToSong(store, 't5', 8, { bars: 2 });
    const before = store.getState();
    cmd.removeBars(store, 0, 4);
    expect(store.getState().tracks[2].songClips).toBeUndefined();
    expect(songNames(store.getState(), 't5')).toEqual(['Lead 1']);
    store.undo();
    expectSame(store.getState(), before);
    const all = store.getState().arrangement.regions.map((r) => r.id);
    cmd.removeRegions(store, all);
    expect(store.getState().tracks.every((t) => t.songClips === undefined)).toBe(true);
    store.undo();
    expectSame(store.getState(), before);
  });

  it('a region switched to another clip leaves its unplayed song clip behind', () => {
    const { store, clip } = fresh();
    const a = cmd.addLoopToSong(store, 't3', 0, { bars: 2 });
    cmd.setRegionClip(store, a.regionId!, clip.Walk);
    expect(store.getState().tracks[2].songClips).toBeUndefined();
    expectValid(store.getState());
  });

  it('pad edits never touch song clips', () => {
    const { store } = fresh();
    cmd.addLoopToSong(store, 't3', 0, { bars: 2, notes: [note(0)] });
    const song = store.getState().tracks[2].songClips;
    expect(cmd.applyVariation(store, 't3', 0, 7).changed).toBe(true);
    expect(cmd.setClipBars(store, 't3', 1, 4).changed).toBe(true);
    expect(cmd.clearTrackClips(store, 't3').changed).toBe(true);
    expect(store.getState().tracks[2].songClips).toBe(song);
  });
});

describe('clip commands work on song slots', () => {
  function withLoop() {
    const s = fresh();
    const a = cmd.addLoopToSong(s.store, 't3', 0, { bars: 2, notes: [note(0), note(48, 50), note(TICKS_PER_BAR + 24, 53)] });
    s.store.clearHistory();
    return { ...s, slot: a.slot!, clipId: a.clipId! };
  }
  const loop = (store: ProjectStore, slot: number) => clipAtSlot(store.getState().tracks[2], slot)!;

  it('rename, notes, transpose, clear, Variation', () => {
    const { store, slot } = withLoop();
    expect(cmd.renameClip(store, 't3', slot, 'Wobble').changed).toBe(true);
    expect(loop(store, slot).name).toBe('Wobble');
    expect(cmd.toggleStep(store, 't3', slot, 2, 60).changed).toBe(true);
    expect(loop(store, slot).notes).toHaveLength(4);
    const id = loop(store, slot).notes[0].id;
    expect(cmd.moveNotes(store, 't3', slot, [id], 24, 1).changed).toBe(true);
    expect(cmd.transposeClip(store, 't3', slot, 2).changed).toBe(true);
    expect(cmd.addRecordedNotes(store, 't3', slot, [note(300, 70)], { quantize: '1/16', mode: 'overdub' }).changed).toBe(true);
    expect(cmd.applyVariation(store, 't3', slot, 11).changed).toBe(true);
    expect(cmd.setClipNotes(store, 't3', slot, [], 'Back to original', { variation: null }).changed).toBe(true);
    expect(loop(store, slot).notes).toEqual([]);
    expect(store.getState().tracks[2].songClips).toHaveLength(1);
    expectValid(store.getState());
    while (store.canUndo()) store.undo();
    expect(loop(store, slot).name).toBe('Bass 1');
    expect(loop(store, slot).notes).toHaveLength(3);
  });

  it('a new length keeps the song valid exactly as for pad clips', () => {
    const { store, slot } = withLoop();
    const id = store.getState().arrangement.regions[0].id;
    cmd.resizeRegions(store, [id], 'end', 6);
    expect(sketch(store.getState())).toEqual(['t3:Bass 1@0+8~0']);
    expect(cmd.setClipBars(store, 't3', slot, 3).changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t3:Bass 1@0+8~0']);
    expect(loop(store, slot).notes).toHaveLength(3);
    expect(cmd.setClipBars(store, 't3', slot, 1).changed).toBe(true);
    expect(loop(store, slot).notes).toHaveLength(2);
    expectValid(store.getState());
    expect(cmd.duplicateClipContent(store, 't3', slot).changed).toBe(true);
    expect(loop(store, slot).bars).toBe(2);
    expect(cmd.repeatClipToBars(store, 't3', slot, 8).changed).toBe(true);
    expect(loop(store, slot).bars).toBe(8);
    expectValid(store.getState());
  });

  it('a song clip can be copied to the clipboard and a progression written into it', () => {
    const { store, slot } = withLoop();
    expect(cmd.copyClip(store.getState(), 't3', slot)?.name).toBe('Bass 1');
    const r = cmd.createProgressionClip(store, 't3', slot, { progressionId: PROGRESSIONS[0].id, rhythm: 'held', bars: 4, size: 3 });
    expect(r.changed).toBe(true);
    expect(loop(store, slot).bars).toBe(4);
    expect(store.getState().tracks[2].clips.filter(Boolean)).toHaveLength(2);
  });

  it('a slot past the part’s song clips is refused', () => {
    const { store, slot } = withLoop();
    expectRefused(store, () => cmd.renameClip(store, 't3', slot + 1, 'X'), 'not-found');
    expectRefused(store, () => cmd.toggleStep(store, 't3', slot + 1, 0, 48), 'invalid');
  });

  it('pad-grid commands refuse a song slot with a plain message and no step', () => {
    const { store, slot } = withLoop();
    expectRefused(store, () => cmd.createClip(store, 't3', slot + 1), 'invalid');
    expectRefused(store, () => cmd.deleteClip(store, 't3', slot), 'invalid');
    expectRefused(store, () => cmd.moveClip(store, 't3', slot, 't3', 3), 'invalid');
    expectRefused(store, () => cmd.moveClip(store, 't3', 0, 't3', slot), 'invalid');
    expectRefused(store, () => cmd.copyClipTo(store, 't3', slot, 't3', 3), 'invalid');
    expectRefused(store, () => cmd.duplicateClipToSlot(store, 't3', slot, 3), 'invalid');
    expectRefused(store, () => cmd.pasteClip(store, 't3', slot, loop(store, slot)), 'invalid');
  });
});

describe('makeLoopUnique', () => {
  it('copies a pad clip into a song clip only this loop plays; the other loops keep the pad clip', () => {
    const { store, clip } = fresh();
    cmd.addRegions(store, [
      { trackId: 't3', clipId: clip.Bounce, start: 0, bars: 4 },
      { trackId: 't3', clipId: clip.Bounce, start: 4, bars: 4, offset: 1 },
    ]);
    store.clearHistory();
    const before = store.getState();
    const second = before.arrangement.regions[1].id;
    const r = cmd.makeLoopUnique(store, second);
    expect(r).toMatchObject({ changed: true, slot: songSlot(0) });
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+4~0', 't3:Bounce 2@4+4~1']);
    expect(store.undoLabel()).toBe('Make Bounce 2');
    cmd.clearClip(store, 't3', r.slot!);
    expect(store.getState().tracks[2].clips[0]?.notes).toHaveLength(1);
    expectValid(store.getState());
    store.undo();
    store.undo();
    expectSame(store.getState(), before);
  });

  it('copies a song clip with the next free number; a song clip played once is already its own', () => {
    const { store } = fresh();
    const a = cmd.addLoopToSong(store, 't3', 0, { bars: 1, name: 'Four Floor' });
    expectRefused(store, () => cmd.makeLoopUnique(store, a.regionId!), 'invalid');
    cmd.duplicateRegions(store, [a.regionId!]);
    cmd.duplicateRegions(store, [store.getState().arrangement.regions[1].id]);
    const ids = store.getState().arrangement.regions.map((x) => x.id);
    expect(cmd.loopUse(store.getState(), 't3', a.clipId!)).toBe(3);
    cmd.makeLoopUnique(store, ids[1]);
    cmd.makeLoopUnique(store, ids[2]);
    expect(sketch(store.getState())).toEqual(['t3:Four Floor@0+1~0', 't3:Four Floor 2@1+1~0', 't3:Four Floor 3@2+1~0']);
    expect(cmd.loopUse(store.getState(), 't3', a.clipId!)).toBe(1);
    expectRefused(store, () => cmd.makeLoopUnique(store, 'rg_gone'), 'not-found');
  });
});

describe('copyLoopToPad', () => {
  it('copies a song clip onto the first empty pad, or a chosen one; the song keeps its loop', () => {
    const { store } = fresh();
    const a = cmd.addLoopToSong(store, 't3', 0, { bars: 2, notes: [note(0)] });
    const before = store.getState();
    const r = cmd.copyLoopToPad(store, 't3', a.slot!);
    expect(r).toMatchObject({ changed: true, slot: 2 });
    const pad = store.getState().tracks[2].clips[2]!;
    expect(pad.name).toBe('Bass 1');
    expect(pad.id).not.toBe(a.clipId);
    expect(store.undoLabel()).toBe('Copy Bass 1 to a pad');
    expect(sketch(store.getState())).toEqual(sketch(before));
    expect(cmd.copyLoopToPad(store, 't3', a.slot!, 3)).toMatchObject({ changed: true, slot: 3 });
    expectRefused(store, () => cmd.copyLoopToPad(store, 't3', a.slot!, 0), 'occupied');
    expectRefused(store, () => cmd.copyLoopToPad(store, 't3', a.slot!), 'occupied');
    expect(cmd.copyLoopToPad(store, 't3', a.slot!).message).toBe('All 4 pads of Bass are full: delete or move a loop first.');
    expectRefused(store, () => cmd.copyLoopToPad(store, 't3', 0), 'invalid');
    expectRefused(store, () => cmd.copyLoopToPad(store, 't3', a.slot! + 1), 'not-found');
    store.undo();
    store.undo();
    expectSame(store.getState(), before);
  });
});

describe('recordTakeIntoSong', () => {
  it('cuts a take into 8-bar clips (the last rounded up, its region only the bars recorded) back to back from the start bar, in one step', () => {
    const { store, clip } = fresh();
    cmd.addRegions(store, [{ trackId: 't3', clipId: clip.Bounce, start: 0, bars: 32 }]);
    store.clearHistory();
    const before = store.getState();
    const bar = TICKS_PER_BAR;
    const r = cmd.recordTakeIntoSong(store, {
      trackId: 't3',
      startBar: 4,
      bars: 11,
      notes: [note(-5), note(bar * 8 - 24, 50, 96), note(bar * 9 + 1, 52), note(bar * 9 + 1, 52), note(bar * 10 + 30, 55)],
    });
    expect(r.changed).toBe(true);
    expect(store.historySize().undo).toBe(1);
    expect(store.undoLabel()).toBe('Record Bass');
    const p = store.getState();
    expect(sketch(p)).toEqual(['t3:Bounce@0+4~0', 't3:Bass take 1@4+8~0', 't3:Bass take 2@12+3~0', 't3:Bounce@15+17~3']);
    const [a, b] = p.tracks[2].songClips!;
    expect(a.bars).toBe(8);
    expect(b.bars).toBe(4);
    // Snapped before the start → on it; crossing the boundary → cut at it.
    expect(a.notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual([
      [0, 48, 24],
      [bar * 8 - 24, 50, 24],
    ]);
    // Ticks counted from the clip's start; a repeat is one note; quantized to the project's setting (1/16).
    expect(b.notes.map((n) => [n.tick, n.pitch])).toEqual([
      [bar, 52],
      [bar * 2 + 24, 55],
    ]);
    expect(r.regionIds).toHaveLength(2);
    expectValid(p);
    store.undo();
    expectSame(store.getState(), before);
    store.redo();
    expect(sketch(store.getState())).toEqual(sketch(p));
  });

  it('a short take makes one clip of 1, 2 or 4 bars; later notes make the take longer; names skip used ones', () => {
    const { store } = fresh();
    cmd.addLoopToSong(store, 't5', 20, { bars: 1, name: 'Lead take 1' });
    const r = cmd.recordTakeIntoSong(store, { trackId: 't5', startBar: 0, bars: 1, notes: [note(TICKS_PER_BAR * 2 + 10, 60)], quantize: 'off' });
    expect(r.changed).toBe(true);
    const p = store.getState();
    // Takes are named "<Part> take N", skipping names in use.
    expect(songNames(p, 't5')).toEqual(['Lead take 1', 'Lead take 2']);
    expect(p.tracks[4].songClips![1]).toMatchObject({ bars: 4 });
    expect(p.tracks[4].songClips![1].notes[0].tick).toBe(TICKS_PER_BAR * 2 + 10);
    // The loop is 4 bars; the song plays the 3 bars recorded.
    expect(sketch(p)).toEqual(['t5:Lead take 2@0+3~0', 't5:Lead take 1@20+1~0']);
  });

  it('an empty take leaves no step and says so', () => {
    const { store } = fresh();
    expectRefused(store, () => cmd.recordTakeIntoSong(store, { trackId: 't3', startBar: 0, bars: 4, notes: [] }), 'empty');
    expect(cmd.recordTakeIntoSong(store, { trackId: 't1', startBar: 0, bars: 4, notes: [note(0, 60)] }).message).toBe('Nothing was played, so nothing was recorded.');
    expectRefused(store, () => cmd.recordTakeIntoSong(store, { trackId: 't3', startBar: -1, bars: 4, notes: [note(0)] }), 'invalid');
    expectRefused(store, () => cmd.recordTakeIntoSong(store, { trackId: 'gone', startBar: 0, bars: 4, notes: [note(0)] }), 'not-found');
  });

  it('a take running past the end of the song keeps what fits', () => {
    const { store } = fresh();
    const r = cmd.recordTakeIntoSong(store, { trackId: 't3', startBar: MAX_SONG_BARS - 2, bars: 1, notes: [note(0), note(TICKS_PER_BAR * 5)] });
    expect(r.changed).toBe(true);
    expect(r.message).toMatch(/1 note past the end/);
    expect(sketch(store.getState())).toEqual([`t3:Bass take 1@${MAX_SONG_BARS - 2}+2~0`]);
    expectValid(store.getState());
  });
});

describe('Move the song moves song clips too', () => {
  it('transposeSong moves a song clip’s notes with the pads', () => {
    const { store } = fresh();
    const a = cmd.addLoopToSong(store, 't3', 0, { bars: 1, notes: [note(0, 48)] });
    cmd.transposeSong(store, { root: 2, scale: store.getState().scale });
    expect(clipAtSlot(store.getState().tracks[2], a.slot!)?.notes[0].pitch).toBe(50);
  });
});
