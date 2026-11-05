/** Review probe: Cut then Paste (the Song view's Ctrl+X, Ctrl+V: songActions cutLoops → pasteLoops) of a song loop. */
import { expect, it } from 'vitest';
import { songStore } from './r5-song-fixtures';
import * as cmd from '../../src/state/commands';

it('a loop that lives in the song survives Cut and Paste (as a pad loop does)', () => {
  const { store } = songStore();
  const a = cmd.addLoopToSong(store, 't3', 0, { bars: 2, notes: [{ tick: 0, pitch: 40, velocity: 0.8, duration: 48 }] });
  expect(a.changed).toBe(true);
  // Cut = copyRegions + removeRegions (songActions.cutLoops).
  const clip = cmd.copyRegions(store.getState(), [a.regionId!])!;
  expect(cmd.removeRegions(store, [a.regionId!]).changed).toBe(true);
  expect(store.getState().tracks[2].songClips).toBeUndefined(); // dropped with its last region
  const r = cmd.pasteRegions(store, clip, 8);
  console.info('[review] paste:', JSON.stringify(r));
  expect(r.changed).toBe(true);
});

it('pasting a cut song loop brings its clip back once (notes, length, name), in one undo step, on its part', () => {
  const { store } = songStore();
  const a = cmd.addLoopToSong(store, 't3', 0, { bars: 2, name: 'Bass take 1', notes: [{ tick: 0, pitch: 40, velocity: 0.8, duration: 48 }, { tick: 96, pitch: 43, velocity: 0.7, duration: 48 }] });
  const id = a.regionId!;
  // The loop plays twice: a second region of the same song clip.
  const twice = cmd.addRegions(store, [{ trackId: 't3', clipId: a.clipId!, start: 4, bars: 2 }]);
  const ids = [id, ...twice.ids!];
  const clip = cmd.copyRegions(store.getState(), ids)!;
  expect(cmd.removeRegions(store, ids).changed).toBe(true);
  expect(store.getState().tracks[2].songClips).toBeUndefined();
  const steps = store.historySize().undo;
  const r = cmd.pasteRegions(store, clip, 8);
  expect(r).toMatchObject({ changed: true, skipped: 0 });
  expect(store.historySize().undo).toBe(steps + 1);
  const t = store.getState().tracks[2];
  expect(t.songClips).toHaveLength(1);
  const back = t.songClips![0];
  expect(back).toMatchObject({ name: 'Bass take 1', bars: 2 });
  expect(back.notes.map((n) => [n.tick, n.pitch])).toEqual([[0, 40], [96, 43]]);
  const pasted = store.getState().arrangement.regions.filter((x) => r.ids!.includes(x.id));
  expect(pasted.map((x) => `${x.trackId}:${x.clipId === back.id}@${x.start}+${x.bars}`)).toEqual(['t3:true@8+2', 't3:true@12+2']);
  store.undo();
  expect(store.getState().tracks[2].songClips).toBeUndefined();
});
