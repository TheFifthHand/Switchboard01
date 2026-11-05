import { expect, it } from 'vitest';
import { songStore } from './r5-song-fixtures';
import * as cmd from '../../src/state/commands';
import { playedSlots } from '../../src/app/views/shape/drumMix';
import { exportNotes, songMidi } from '../../src/render/midi';
import { stemParts } from '../../src/render/stems';
import { createClip } from '../../src/project/factory';
import { checkImport } from '../../src/app/views/sampler/importState';

it('Drum mix counts the voices a drum part’s song loops play', () => {
  const { store } = songStore();
  const p0 = store.getState();
  // A drums part whose only loop lives in the song (a library beat): kick, snare, hats.
  const d = structuredClone(p0);
  d.tracks[0].clips = d.tracks[0].clips.map(() => null);
  d.arrangement.regions = [];
  store.replace(d, { resetHistory: true });
  const r = cmd.addLoopToSong(store, 't1', 0, { bars: 1, notes: [{ tick: 0, pitch: 0, velocity: 1, duration: 24 }, { tick: 96, pitch: 2, velocity: 1, duration: 24 }, { tick: 48, pitch: 4, velocity: 1, duration: 24 }] });
  expect(r.changed).toBe(true);
  expect([...playedSlots(store.getState().tracks[0]).keys()].sort()).toEqual([0, 2, 4]);
});

it('MIDI and parts leave out drum notes the kit cannot play (as playback does)', () => {
  const { store } = songStore();
  const p = structuredClone(store.getState());
  // A part switched from bass to drums keeps its bass notes (validation keeps any MIDI pitch); the kit plays pads 0..15 only.
  const t = p.tracks[0];
  t.clips = t.clips.map(() => null);
  const c = createClip('Old bass', 1, [{ tick: 0, pitch: 40, velocity: 0.8, duration: 96 }]);
  t.clips[0] = c;
  p.tracks.forEach((x, i) => { if (i) x.mute = true; });
  p.arrangement.regions = [{ id: 'r1', trackId: t.id, clipId: c.id, start: 0, bars: 1, offset: 0 }];
  const notes = exportNotes(p, { kind: 'song' }).find((x) => x.trackId === t.id)!.notes;
  console.info('[review] drum part notes exported:', JSON.stringify(notes), 'midi bytes', songMidi(p, { kind: 'song' })?.length ?? null, 'stems', JSON.stringify(stemParts(p, { kind: 'song' })));
  expect(notes).toEqual([]);
  // A part with nothing audible gets no file of its own, and the MIDI file has no notes for it.
  expect(stemParts(p, { kind: 'song' }).map((x) => x.trackId)).not.toContain(t.id);
});

it('importing a recording onto a part says its song loops will play it too', () => {
  const { store } = songStore();
  const d = structuredClone(store.getState());
  d.tracks[2].clips = d.tracks[2].clips.map(() => null);
  d.arrangement.regions = [];
  store.replace(d, { resetHistory: true });
  expect(checkImport(store.getState(), 't3').kind).toBe('ok');
  cmd.addLoopToSong(store, 't3', 0, { bars: 1, name: 'Song bass', notes: [{ tick: 0, pitch: 40, velocity: 0.8, duration: 48 }] });
  const c = checkImport(store.getState(), 't3');
  expect(c.kind).toBe('converts');
  expect(c.kind === 'converts' && c.message).toMatch(/Song bass/);
});
